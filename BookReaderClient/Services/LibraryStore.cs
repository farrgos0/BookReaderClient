using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using SQLite;

namespace BookReaderClient.Services;

/// <summary>Карточка книги в SQLite. Сам файл книги лежит рядом: books/{Id}.bin.</summary>
[Table("books")]
public class BookRow
{
    [PrimaryKey] public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string AuthorsJson { get; set; } = "[]";
    public string Format { get; set; } = "";
    public string FormatLabel { get; set; } = "";
    public string Name { get; set; } = "";
    public string Type { get; set; } = "";
    public long Size { get; set; }
    public long AddedAt { get; set; }
    public long OpenedAt { get; set; }
    public int Pos { get; set; }
    public int SegCount { get; set; }
    public double Progress { get; set; }
    public string? Cover { get; set; }
    public bool CustomMeta { get; set; }
    /// <summary>Найденные автоматически главы (JSON от веб-части) — null, если не искали.</summary>
    public string? Chapters { get; set; }
    /// <summary>Избранное (звёздочка в библиотеке). Столбец добавляется в старую базу сам (CreateTable).</summary>
    public bool Favorite { get; set; }
}

/// <summary>Библиотека на устройстве: SQLite + файлы. Без синхронизации.</summary>
public sealed class LibraryStore
{
    readonly object sync = new();
    SQLiteConnection? db;
    readonly Dictionary<string, Upload> uploads = new();

    sealed class Upload
    {
        public required string TmpPath;
        public required FileStream Stream;
        public required IncrementalHash Hash;
        public required string Name;
        public required string Type;
    }

    static string Root => FileSystem.AppDataDirectory;
    static string BooksDir { get { var d = Path.Combine(Root, "books"); Directory.CreateDirectory(d); return d; } }
    static string FilePath(string id) => Path.Combine(BooksDir, id + ".bin");
    static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    static bool sqliteReady;

    /// <summary>Подключить нативный SQLite (bundle_e_sqlite3). Нужно один раз до первого соединения.</summary>
    public static void InitSqlite()
    {
        if (sqliteReady) return;
        SQLitePCL.Batteries_V2.Init();
        sqliteReady = true;
    }

    /// <summary>Версия SQLite внутри приложения (для экрана инструментов разработчика).</summary>
    public static string SqliteVersion()
    {
        InitSqlite();
        return SQLitePCL.raw.sqlite3_libversion().utf8_to_string();
    }

    SQLiteConnection Db
    {
        get
        {
            if (db != null) return db;
            InitSqlite();
            db = new SQLiteConnection(Path.Combine(Root, "library.db3"));
            db.CreateTable<BookRow>();
            return db;
        }
    }

    // ---------- чтение ----------

    public string ListJson()
    {
        lock (sync) return Serialize(Db.Table<BookRow>().ToList().Select(ToJs));
    }

    public string? GetJson(string id)
    {
        lock (sync) { var r = Db.Find<BookRow>(id); return r == null ? null : Serialize(ToJs(r)); }
    }

    public string? FileInfoJson(string id)
    {
        lock (sync)
        {
            var r = Db.Find<BookRow>(id);
            var path = FilePath(id);
            if (r == null || !File.Exists(path)) return null;
            return Serialize(new { name = r.Name, type = r.Type, size = new FileInfo(path).Length });
        }
    }

    public string ReadChunkBase64(string id, long offset, int length)
    {
        using var fs = File.OpenRead(FilePath(id));
        fs.Seek(offset, SeekOrigin.Begin);
        var buf = new byte[length];
        int read = 0;
        while (read < length)
        {
            var n = fs.Read(buf, read, length - read);
            if (n <= 0) break;
            read += n;
        }
        return Convert.ToBase64String(buf, 0, read);
    }

    public string EstimateJson()
    {
        lock (sync) return Serialize(new { usage = Db.Table<BookRow>().ToList().Sum(r => r.Size) });
    }

    // ---------- изменение ----------

    public void Update(string id, string patchJson)
    {
        lock (sync)
        {
            var r = Db.Find<BookRow>(id);
            if (r == null) return;
            var patch = JsonNode.Parse(patchJson)?.AsObject();
            if (patch == null) return;
            foreach (var (key, v) in patch)
            {
                switch (key)
                {
                    case "title": r.Title = v?.GetValue<string>() ?? r.Title; break;
                    case "authors": r.AuthorsJson = v?.ToJsonString() ?? "[]"; break;
                    case "format": r.Format = v?.GetValue<string>() ?? ""; break;
                    case "formatLabel": r.FormatLabel = v?.GetValue<string>() ?? ""; break;
                    case "cover": r.Cover = v?.GetValue<string>(); break;
                    case "pos": r.Pos = (int)Num(v); break;
                    case "segCount": r.SegCount = (int)Num(v); break;
                    case "progress": r.Progress = Num(v); break;
                    case "openedAt": r.OpenedAt = (long)Num(v); break;
                    case "customMeta": r.CustomMeta = v?.GetValue<bool>() ?? false; break;
                    case "chapters": r.Chapters = v?.ToJsonString(); break;
                    case "favorite": r.Favorite = v?.GetValue<bool>() ?? false; break;
                }
            }
            Db.Update(r);
        }
    }

    public void Remove(string id)
    {
        lock (sync)
        {
            Db.Delete<BookRow>(id);
            TryDelete(FilePath(id));
        }
    }

    public void Clear()
    {
        lock (sync)
        {
            Db.DeleteAll<BookRow>();
            foreach (var f in Directory.GetFiles(BooksDir)) TryDelete(f);
        }
    }

    // ---------- добавление из веб-части (по кускам base64) ----------

    public string BeginAdd(string name, string type)
    {
        var token = Guid.NewGuid().ToString("N");
        var tmp = Path.Combine(FileSystem.CacheDirectory, "upload_" + token);
        lock (sync)
        {
            uploads[token] = new Upload
            {
                TmpPath = tmp, Stream = File.Create(tmp), Hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256),
                Name = name, Type = type,
            };
        }
        return token;
    }

    public void Append(string token, string base64)
    {
        Upload u;
        lock (sync) u = uploads[token];
        var bytes = Convert.FromBase64String(base64);
        u.Stream.Write(bytes);
        u.Hash.AppendData(bytes);
    }

    public string FinishAdd(string token, string metaJson)
    {
        Upload u;
        lock (sync) { u = uploads[token]; uploads.Remove(token); }
        u.Stream.Dispose();
        var id = HashId(u.Hash.GetHashAndReset());
        u.Hash.Dispose();
        var meta = JsonNode.Parse(metaJson)?.AsObject() ?? new JsonObject();
        var (row, _) = StoreFile(id, u.TmpPath, u.Name, u.Type, meta);
        return Serialize(ToJs(row));
    }

    // ---------- добавление системным диалогом ----------

    public async Task<string> PickFilesJson()
    {
        var picked = await FilePicker.Default.PickMultipleAsync(new PickOptions { PickerTitle = "Выберите книги" });
        var result = new List<object>();
        if (picked == null) return Serialize(result);
        foreach (var f in picked)
        {
            if (f == null) continue;
            var tmp = Path.Combine(FileSystem.CacheDirectory, "pick_" + Guid.NewGuid().ToString("N"));
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            await using (var src = await f.OpenReadAsync())
            await using (var dst = File.Create(tmp))
            {
                var buf = new byte[81920];
                int n;
                while ((n = await src.ReadAsync(buf)) > 0)
                {
                    await dst.WriteAsync(buf.AsMemory(0, n));
                    hash.AppendData(buf, 0, n);
                }
            }
            var id = HashId(hash.GetHashAndReset());
            var meta = new JsonObject
            {
                ["title"] = Path.GetFileNameWithoutExtension(f.FileName),
                ["format"] = Path.GetExtension(f.FileName).TrimStart('.').ToLowerInvariant(),
            };
            var (row, isNew) = StoreFile(id, tmp, f.FileName, f.ContentType ?? "", meta);
            result.Add(new { id = row.Id, name = f.FileName, isNew });
        }
        return Serialize(result);
    }

    /// <summary>Добавить уже скачанный файл (каталог сервера). Ответ: { id, name, isNew }.</summary>
    public string AddFileJson(string tmpPath, string name)
    {
        string id;
        using (var f = File.OpenRead(tmpPath)) id = HashId(SHA256.HashData(f));
        var meta = new JsonObject
        {
            ["title"] = Path.GetFileNameWithoutExtension(name),
            ["format"] = Path.GetExtension(name).TrimStart('.').ToLowerInvariant(),
        };
        var (row, isNew) = StoreFile(id, tmpPath, name, "", meta);
        return Serialize(new { id = row.Id, name, isNew });
    }

    /// <summary>Копия файла книги с исходным именем (для «Поделиться»).</summary>
    public string ExportCopy(string id, bool clean = true)
    {
        BookRow? row;
        lock (sync) row = Db.Find<BookRow>(id);
        if (row == null || !File.Exists(FilePath(id))) throw new InvalidOperationException("файл книги не найден");
        var dir = Path.Combine(FileSystem.CacheDirectory, "export");
        if (clean)
        {
            try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { }
        }
        Directory.CreateDirectory(dir);
        var name = string.Concat(row.Name.Split(Path.GetInvalidFileNameChars()));
        if (string.IsNullOrWhiteSpace(name)) name = id + ".fb2";
        var dest = Path.Combine(dir, name);
        // одинаковые имена у разных книг — добавляем номер
        for (var k = 2; File.Exists(dest); k++)
            dest = Path.Combine(dir, $"{Path.GetFileNameWithoutExtension(name)} ({k}){Path.GetExtension(name)}");
        File.Copy(FilePath(id), dest, true);
        return dest;
    }

    // ---------- общее ----------

    (BookRow Row, bool IsNew) StoreFile(string id, string tmpPath, string name, string type, JsonObject meta)
    {
        lock (sync)
        {
            var existing = Db.Find<BookRow>(id);
            if (existing != null)
            {
                TryDelete(tmpPath);
                existing.OpenedAt = Now;
                Db.Update(existing);
                return (existing, false);
            }
            var dest = FilePath(id);
            if (File.Exists(dest)) File.Delete(dest);
            File.Move(tmpPath, dest);
            var row = new BookRow
            {
                Id = id, Name = name, Type = type, Size = new FileInfo(dest).Length,
                AddedAt = Now, OpenedAt = Now,
                Title = meta["title"]?.GetValue<string>() ?? Path.GetFileNameWithoutExtension(name),
                AuthorsJson = meta["authors"]?.ToJsonString() ?? "[]",
                Format = meta["format"]?.GetValue<string>() ?? "",
                FormatLabel = meta["formatLabel"]?.GetValue<string>() ?? (meta["format"]?.GetValue<string>() ?? "").ToUpperInvariant(),
                Cover = meta["cover"]?.GetValue<string>(),
            };
            Db.Insert(row);
            return (row, true);
        }
    }

    static object ToJs(BookRow r) => new
    {
        id = r.Id, title = r.Title, authors = ParseAuthors(r.AuthorsJson), format = r.Format, formatLabel = r.FormatLabel,
        name = r.Name, size = r.Size, addedAt = r.AddedAt, openedAt = r.OpenedAt, pos = r.Pos, segCount = r.SegCount,
        progress = r.Progress, cover = r.Cover, customMeta = r.CustomMeta, chapters = ParseNode(r.Chapters),
        favorite = r.Favorite,
    };

    static JsonNode? ParseNode(string? json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try { return JsonNode.Parse(json); } catch { return null; }
    }

    static string[] ParseAuthors(string json)
    {
        try { return JsonSerializer.Deserialize<string[]>(json) ?? []; } catch { return []; }
    }

    static double Num(JsonNode? v)
    {
        if (v == null) return 0;
        try { return v.GetValue<double>(); } catch { }
        try { return v.GetValue<long>(); } catch { }
        return 0;
    }

    static string HashId(byte[] hash) => Convert.ToHexString(hash, 0, 10).ToLowerInvariant();
    static string Serialize(object o) => JsonSerializer.Serialize(o);
    static void TryDelete(string path) { try { if (File.Exists(path)) File.Delete(path); } catch { } }
}
