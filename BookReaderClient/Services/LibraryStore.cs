using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
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
    /// <summary>Аудиокнига (шаг 8): длительность, части (смещения в файле), главы — JSON от веб-части; null — обычная книга.</summary>
    public string? Audio { get; set; }
    /// <summary>Аудиокнига: место прослушивания, секунды от начала книги.</summary>
    public double APos { get; set; }
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
    /// <summary>Файл книги на устройстве (плеер аудиокниг читает его кусками).</summary>
    public static string BookFile(string id) => FilePath(id);
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

    /// <summary>Номера всех книг библиотеки (очистка озвучки книг, которых больше нет).</summary>
    public HashSet<string> Ids()
    {
        lock (sync) return Db.Table<BookRow>().ToList().Select(r => r.Id).ToHashSet(StringComparer.Ordinal);
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
                    case "audio": r.Audio = v?.ToJsonString(); break;
                    case "apos": r.APos = Num(v); break;
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

    // ---------- аудиокниги: сборка в ZIP без сжатия ----------

    static readonly string[] AudioExt = [".mp3", ".m4b", ".m4a", ".mp4", ".ogg", ".oga", ".opus", ".flac", ".wav"];
    static readonly string[] ImageExt = [".jpg", ".jpeg", ".png", ".webp"];
    static bool IsPackable(string name)
    {
        var ext = Path.GetExtension(name).ToLowerInvariant();
        if (name.EndsWith('/') || name.Contains("__MACOSX/") || Path.GetFileName(name).StartsWith("._")) return false;
        return AudioExt.Contains(ext) || ImageExt.Contains(ext);
    }

    sealed record PackItem(string Name, string Path, string? Entry, long Length);

    /// <summary>
    /// Несколько файлов библиотеки (аудио и/или ZIP с аудио) → одна аудиокнига: ZIP без сжатия. Части в нём лежат
    /// подряд, их можно слушать прямо из файла. Порядок — по именам «по-человечески» (2 раньше 10).
    /// Ответ: { id, name, isNew }. Исходные файлы не удаляются (это решает веб-часть).
    /// </summary>
    public string PackAudioJson(string idsJson, string name)
    {
        var ids = JsonSerializer.Deserialize<string[]>(idsJson) ?? [];
        var items = new List<PackItem>();
        foreach (var id in ids)
        {
            BookRow? row;
            lock (sync) row = Db.Find<BookRow>(id);
            var path = FilePath(id);
            if (row == null || !File.Exists(path)) continue;
            if (IsZip(path))
            {
                using var zip = ZipFile.OpenRead(path);
                foreach (var e in zip.Entries)
                    if (IsPackable(e.FullName)) items.Add(new PackItem(e.FullName, path, e.FullName, e.Length));
            }
            else if (IsPackable(row.Name)) items.Add(new PackItem(row.Name, path, null, new FileInfo(path).Length));
        }
        if (!items.Any(i => AudioExt.Contains(Path.GetExtension(i.Name).ToLowerInvariant())))
            throw new InvalidOperationException("в выбранных файлах нет аудио");
        items.Sort((a, b) => NaturalCompare(a.Name, b.Name));
        if (items.Sum(i => i.Length) > 4000L * 1024 * 1024) throw new InvalidOperationException("книга больше 4 ГБ — такие пока не поддерживаются");

        // одинаковые имена из разных архивов — с номером
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var names = items.Select(i =>
        {
            var nm = i.Name;
            for (var k = 2; !used.Add(nm); k++) nm = $"{Path.ChangeExtension(i.Name, null)} ({k}){Path.GetExtension(i.Name)}";
            return nm;
        }).ToList();

        var tmp = Path.Combine(FileSystem.CacheDirectory, "pack_" + Guid.NewGuid().ToString("N"));
        try
        {
            using (var dst = new FileStream(tmp, FileMode.Create, FileAccess.ReadWrite))
            {
                var central = new MemoryStream();
                var buf = new byte[256 * 1024];
                for (var n = 0; n < items.Count; n++)
                {
                    var it = items[n];
                    var nb = Encoding.UTF8.GetBytes(names[n]);
                    var headerAt = dst.Position;
                    WriteLocal(dst, nb, 0, it.Length);
                    uint crc = 0xffffffff;
                    long copied = 0;
                    using (var src = OpenItem(it, out var zip))
                    using (zip)
                    {
                        int r;
                        while ((r = src.Read(buf, 0, buf.Length)) > 0)
                        {
                            crc = Crc32(crc, buf, r);
                            dst.Write(buf, 0, r);
                            copied += r;
                        }
                    }
                    if (copied != it.Length) throw new InvalidDataException($"«{it.Name}»: файл прочитан не полностью");
                    crc ^= 0xffffffff;
                    var end = dst.Position;
                    dst.Position = headerAt + 14;
                    dst.Write(BitConverter.GetBytes(crc));
                    dst.Position = end;
                    WriteCentral(central, nb, crc, it.Length, headerAt);
                }
                var cdAt = dst.Position;
                central.Position = 0;
                central.CopyTo(dst);
                var eocd = new byte[22];
                BitConverter.GetBytes(0x06054b50u).CopyTo(eocd, 0);
                BitConverter.GetBytes((ushort)items.Count).CopyTo(eocd, 8);
                BitConverter.GetBytes((ushort)items.Count).CopyTo(eocd, 10);
                BitConverter.GetBytes((uint)central.Length).CopyTo(eocd, 12);
                BitConverter.GetBytes((uint)cdAt).CopyTo(eocd, 16);
                dst.Write(eocd);
            }
            string id;
            using (var f = File.OpenRead(tmp)) id = HashId(SHA256.HashData(f));
            var meta = new JsonObject { ["title"] = Path.GetFileNameWithoutExtension(name), ["format"] = "zip" };
            var (row, isNew) = StoreFile(id, tmp, name, "application/zip", meta);
            return Serialize(new { id = row.Id, name, isNew });
        }
        catch { TryDelete(tmp); throw; }
    }

    static Stream OpenItem(PackItem it, out IDisposable? owner)
    {
        if (it.Entry == null) { owner = null; return File.OpenRead(it.Path); }
        var zip = ZipFile.OpenRead(it.Path);
        owner = zip;
        return zip.GetEntry(it.Entry)?.Open() ?? throw new FileNotFoundException(it.Entry);
    }

    static bool IsZip(string path)
    {
        using var f = File.OpenRead(path);
        Span<byte> b = stackalloc byte[4];
        return f.Read(b) == 4 && b[0] == 0x50 && b[1] == 0x4b && b[2] == 3 && b[3] == 4;
    }

    static void WriteLocal(Stream s, byte[] name, uint crc, long size)
    {
        var h = new byte[30];
        BitConverter.GetBytes(0x04034b50u).CopyTo(h, 0);
        BitConverter.GetBytes((ushort)10).CopyTo(h, 4);
        BitConverter.GetBytes((ushort)0x800).CopyTo(h, 6);     // имена в UTF-8
        BitConverter.GetBytes(crc).CopyTo(h, 14);
        BitConverter.GetBytes((uint)size).CopyTo(h, 18);
        BitConverter.GetBytes((uint)size).CopyTo(h, 22);
        BitConverter.GetBytes((ushort)name.Length).CopyTo(h, 26);
        s.Write(h);
        s.Write(name);
    }

    static void WriteCentral(Stream s, byte[] name, uint crc, long size, long offset)
    {
        var c = new byte[46];
        BitConverter.GetBytes(0x02014b50u).CopyTo(c, 0);
        BitConverter.GetBytes((ushort)10).CopyTo(c, 4);
        BitConverter.GetBytes((ushort)10).CopyTo(c, 6);
        BitConverter.GetBytes((ushort)0x800).CopyTo(c, 8);
        BitConverter.GetBytes(crc).CopyTo(c, 16);
        BitConverter.GetBytes((uint)size).CopyTo(c, 20);
        BitConverter.GetBytes((uint)size).CopyTo(c, 24);
        BitConverter.GetBytes((ushort)name.Length).CopyTo(c, 28);
        BitConverter.GetBytes((uint)offset).CopyTo(c, 42);
        s.Write(c);
        s.Write(name);
    }

    static readonly uint[] CrcTable = Enumerable.Range(0, 256).Select(n =>
    {
        var c = (uint)n;
        for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xedb88320 ^ (c >> 1) : c >> 1;
        return c;
    }).ToArray();

    static uint Crc32(uint crc, byte[] b, int len)
    {
        for (var i = 0; i < len; i++) crc = CrcTable[(crc ^ b[i]) & 0xff] ^ (crc >> 8);
        return crc;
    }

    /// <summary>Сравнение имён «по-человечески»: числа — как числа (2 раньше 10), без учёта регистра.</summary>
    public static int NaturalCompare(string a, string b)
    {
        int i = 0, j = 0;
        while (i < a.Length && j < b.Length)
        {
            if (char.IsDigit(a[i]) && char.IsDigit(b[j]))
            {
                int si = i, sj = j;
                while (i < a.Length && char.IsDigit(a[i])) i++;
                while (j < b.Length && char.IsDigit(b[j])) j++;
                var na = a[si..i].TrimStart('0');
                var nb = b[sj..j].TrimStart('0');
                if (na.Length != nb.Length) return na.Length - nb.Length;
                var c = string.CompareOrdinal(na, nb);
                if (c != 0) return c;
                continue;
            }
            var d = string.Compare(a[i].ToString(), b[j].ToString(), StringComparison.CurrentCultureIgnoreCase);
            if (d != 0) return d;
            i++; j++;
        }
        return (a.Length - i) - (b.Length - j);
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
        favorite = r.Favorite, audio = ParseNode(r.Audio), apos = r.APos,
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
