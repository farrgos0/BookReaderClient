using System.Globalization;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace BookReaderClient.Services;

/// <summary>
/// Скачанная озвучка книг: audio/{книга}/{голос}/{ключ}.oga + pack.json со статистикой.
/// Ключ фразы — хэш её текста и паузы, поэтому файлы не зависят от номера фразы:
/// если разбивка книги на фразы немного изменится, уже скачанное останется в деле.
/// </summary>
public static class AudioStore
{
    public sealed class PackInfo
    {
        public string Voice { get; set; } = "";
        public string Title { get; set; } = "";
        public int Total { get; set; }
        public int Done { get; set; }
        public long Bytes { get; set; }
        public long UpdatedAt { get; set; }
    }

    static string Root { get { var d = Path.Combine(FileSystem.AppDataDirectory, "audio"); Directory.CreateDirectory(d); return d; } }

    static string Safe(string s) => string.Concat(s.Where(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-'));

    public static string BookDir(string bookId) => Path.Combine(Root, Safe(bookId));
    public static string PackDir(string bookId, string voice) => Path.Combine(BookDir(bookId), Safe(voice));

    public static string Key(string text, double pause)
    {
        var src = text + "\n" + Math.Round(pause, 2).ToString("0.00", CultureInfo.InvariantCulture);
        return Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(src)), 0, 12).ToLowerInvariant();
    }

    public static string PathFor(string bookId, string voice, string key) => Path.Combine(PackDir(bookId, voice), key + ".oga");

    // ---------- быстрые проверки для больших книг (сотни тысяч фраз, 1000+ глав) ----------

    static readonly object idxLock = new();
    static readonly Dictionary<string, HashSet<string>> index = new();   // папка набора → ключи скачанных фраз
    static readonly ConditionalWeakTable<IReadOnlyList<PlaybackEngine.Seg>, string[]> keysCache = new();

    /// <summary>Ключи всех фраз книги (считаются один раз на открытую книгу).</summary>
    public static string[] KeysOf(IReadOnlyList<PlaybackEngine.Seg> segs) =>
        keysCache.GetValue(segs, list =>
        {
            var keys = new string[list.Count];
            for (var i = 0; i < keys.Length; i++) keys[i] = Key(list[i].Text, list[i].Pause);
            return keys;
        });

    static HashSet<string> Index(string bookId, string voice)
    {
        var dir = PackDir(bookId, voice);
        lock (idxLock)
        {
            if (index.TryGetValue(dir, out var set)) return set;
            set = new HashSet<string>(StringComparer.Ordinal);
            try
            {
                if (Directory.Exists(dir))
                    foreach (var f in Directory.EnumerateFiles(dir, "*.oga")) set.Add(Path.GetFileNameWithoutExtension(f));
            }
            catch { }
            index[dir] = set;
            return set;
        }
    }

    public static bool Has(string bookId, string voice, string key)
    {
        if (string.IsNullOrEmpty(bookId) || string.IsNullOrEmpty(voice)) return false;
        var set = Index(bookId, voice);
        lock (idxLock) return set.Contains(key);
    }

    /// <summary>Файл фразы записан (предзагрузка) — отметить без пересканирования папки.</summary>
    public static void MarkSaved(string bookId, string voice, string key)
    {
        var set = Index(bookId, voice);
        lock (idxLock) set.Add(key);
    }

    static void ForgetIndex(string dirPrefix)
    {
        lock (idxLock)
        {
            foreach (var k in index.Keys.Where(k => k.StartsWith(dirPrefix, StringComparison.Ordinal)).ToList()) index.Remove(k);
            foreach (var k in fpCache.Keys.Where(k => k.StartsWith(dirPrefix, StringComparison.Ordinal)).ToList()) { fpCache.Remove(k); fpDirty.Remove(k); }
        }
    }

    /// <summary>Удалить файл одной фразы (устаревшая фраза, которой больше нет в книге).</summary>
    public static void RemovePhrase(string bookId, string voice, string key)
    {
        try { File.Delete(PathFor(bookId, voice, key)); } catch { }
        lock (idxLock)
        {
            Index(bookId, voice).Remove(key);
            var f = Fps(bookId, voice);
            f.Fp.Remove(key);
            f.Stale.Remove(key);
            fpDirty.Add(PackDir(bookId, voice));
        }
    }

    // ---------- отпечатки озвученного текста: обновление скачанной озвучки (шаг 5 спецификации 1.2.0) ----------

    /// <summary>
    /// fp.json рядом с озвучкой: отпечаток того, что реально озвучено в каждой фразе (его даёт сервер вместе
    /// со звуком), с какой версией нормализатора и набором правил последний раз сверяли и какие фразы устарели.
    /// Фраза без отпечатка — скачана до 1.2.0: её звучание неизвестно, она «требует обновления».
    /// </summary>
    public sealed class FpInfo
    {
        public string? Norm { get; set; }
        public string? Stamp { get; set; }
        public Dictionary<string, string> Fp { get; set; } = new(StringComparer.Ordinal);
        public HashSet<string> Stale { get; set; } = new(StringComparer.Ordinal);
    }

    static readonly Dictionary<string, FpInfo> fpCache = new();   // папка набора → отпечатки
    static readonly HashSet<string> fpDirty = new();

    static FpInfo Fps(string bookId, string voice)
    {
        var dir = PackDir(bookId, voice);
        lock (idxLock)
        {
            if (fpCache.TryGetValue(dir, out var f)) return f;
            f = null;
            try
            {
                var path = Path.Combine(dir, "fp.json");
                if (File.Exists(path)) f = JsonSerializer.Deserialize<FpInfo>(File.ReadAllText(path));
            }
            catch { }
            f ??= new FpInfo();
            f.Fp = new Dictionary<string, string>(f.Fp ?? new(), StringComparer.Ordinal);
            f.Stale = new HashSet<string>(f.Stale ?? new(), StringComparer.Ordinal);
            fpCache[dir] = f;
            return f;
        }
    }

    /// <summary>Фраза скачана заново: запомнить её отпечаток (null — сервер старый, отпечатков не даёт).</summary>
    public static void SetFp(string bookId, string voice, string key, string? fp)
    {
        if (string.IsNullOrEmpty(fp)) return;
        lock (idxLock)
        {
            var f = Fps(bookId, voice);
            f.Fp[key] = fp;
            f.Stale.Remove(key);
            fpDirty.Add(PackDir(bookId, voice));
        }
    }

    /// <summary>Отпечатки скачанных фраз (копия) и когда сверяли: (norm, stamp, key → отпечаток).</summary>
    public static (string? Norm, string? Stamp, Dictionary<string, string> Fp) FpSnapshot(string bookId, string voice)
    {
        lock (idxLock)
        {
            var f = Fps(bookId, voice);
            var set = Index(bookId, voice);
            return (f.Norm, f.Stamp, f.Fp.Where(p => set.Contains(p.Key)).ToDictionary(p => p.Key, p => p.Value, StringComparer.Ordinal));
        }
    }

    /// <summary>Итог сверки: какие фразы устарели при этой версии нормализатора и этих правилах.</summary>
    public static void SetChecked(string bookId, string voice, string norm, string stamp, IEnumerable<string> stale)
    {
        lock (idxLock)
        {
            var f = Fps(bookId, voice);
            f.Norm = norm;
            f.Stamp = stamp;
            f.Stale = new HashSet<string>(stale, StringComparer.Ordinal);
            fpDirty.Add(PackDir(bookId, voice));
        }
        SaveFps(bookId, voice);
    }

    /// <summary>Сколько скачанных фраз ждут обновления: устаревшие (сверка) и без отпечатка (скачаны до 1.2.0).</summary>
    public static (int Stale, int Unknown) Outdated(string bookId, string voice)
    {
        lock (idxLock)
        {
            var set = Index(bookId, voice);
            if (set.Count == 0) return (0, 0);
            var f = Fps(bookId, voice);
            var stale = f.Stale.Count(set.Contains);
            var unknown = set.Count(k => !f.Fp.ContainsKey(k));
            return (stale, unknown);
        }
    }

    /// <summary>Ключи фраз, которые обновит кнопка «Обновить» (устаревшие и без отпечатка).</summary>
    public static HashSet<string> OutdatedKeys(string bookId, string voice)
    {
        lock (idxLock)
        {
            var set = Index(bookId, voice);
            var f = Fps(bookId, voice);
            return set.Where(k => f.Stale.Contains(k) || !f.Fp.ContainsKey(k)).ToHashSet(StringComparer.Ordinal);
        }
    }

    public static void SaveFps(string bookId, string voice)
    {
        var dir = PackDir(bookId, voice);
        string json;
        lock (idxLock)
        {
            if (!fpDirty.Contains(dir) || !fpCache.TryGetValue(dir, out var f)) return;
            if (!Directory.Exists(dir)) { fpDirty.Remove(dir); return; }   // озвучку удалили — не воскрешаем папку
            json = JsonSerializer.Serialize(f);
            fpDirty.Remove(dir);
        }
        try
        {
            var tmp = Path.Combine(dir, "fp.json.tmp");
            File.WriteAllText(tmp, json);
            File.Move(tmp, Path.Combine(dir, "fp.json"), true);
        }
        catch { lock (idxLock) fpDirty.Add(dir); }
    }

    /// <summary>Скачанный файл фразы или null.</summary>
    public static string? Find(string bookId, string voice, string key)
    {
        if (!Has(bookId, voice, key)) return null;
        var p = PathFor(bookId, voice, key);
        if (File.Exists(p)) return p;
        lock (idxLock) Index(bookId, voice).Remove(key); // файл пропал — забываем
        return null;
    }

    public static string? Find(string bookId, string voice, string text, double pause) => Find(bookId, voice, Key(text, pause));

    // Паузы, которые веб-часть ставит после фраз (app.js, buildBook): внутри абзаца, конец абзаца, заголовок и т. д.
    static readonly double[] KnownPauses = [0.12, 0.35, 0.9, 0.6, 0.25, 0.8];

    /// <summary>
    /// Ключ скачанной фразы с этим текстом: точный (текст + пауза), а если его нет — тот же текст с другой паузой.
    /// Пауза меняется, когда меняется вид абзаца (например, разметка глав сделала строку заголовком: 0,35 → 0,9 с),
    /// а звучит фраза так же — отличается только тишина после неё. null — фраза не скачана.
    /// </summary>
    public static string? Existing(string bookId, string voice, string text, double pause, string? exact = null)
    {
        exact ??= Key(text, pause);
        if (Has(bookId, voice, exact)) return exact;
        foreach (var p in KnownPauses)
        {
            if (Math.Abs(p - Math.Round(pause, 2)) < 0.001) continue;
            var k = Key(text, p);
            if (Has(bookId, voice, k)) return k;
        }
        return null;
    }

    /// <summary>Файл скачанной фразы (с учётом другой паузы, см. Existing) или null.</summary>
    public static string? FindSeg(string bookId, string voice, string text, double pause, string exact)
    {
        var k = Existing(bookId, voice, text, pause, exact);
        return k == null ? null : Find(bookId, voice, k);
    }

    /// <summary>Фраза скачана заново с точной паузой — убрать её прежние варианты с другой паузой.</summary>
    public static void RemoveAliases(string bookId, string voice, string text, double pause)
    {
        foreach (var p in KnownPauses)
        {
            if (Math.Abs(p - Math.Round(pause, 2)) < 0.001) continue;
            var k = Key(text, p);
            if (Has(bookId, voice, k)) RemovePhrase(bookId, voice, k);
        }
    }

    public static PackInfo? ReadPack(string bookId, string voice)
    {
        try
        {
            var f = Path.Combine(PackDir(bookId, voice), "pack.json");
            return File.Exists(f) ? JsonSerializer.Deserialize<PackInfo>(File.ReadAllText(f)) : null;
        }
        catch { return null; }
    }

    public static void WritePack(string bookId, PackInfo info)
    {
        var dir = PackDir(bookId, info.Voice);
        Directory.CreateDirectory(dir);
        info.UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var tmp = Path.Combine(dir, "pack.json.tmp");
        File.WriteAllText(tmp, JsonSerializer.Serialize(info));
        File.Move(tmp, Path.Combine(dir, "pack.json"), true);
    }

    /// <summary>Все скачанные наборы: (книга, сведения).</summary>
    public static List<(string BookId, PackInfo Info)> AllPacks()
    {
        var list = new List<(string, PackInfo)>();
        foreach (var bookDir in Directory.GetDirectories(Root))
        {
            var bookId = Path.GetFileName(bookDir);
            foreach (var voiceDir in Directory.GetDirectories(bookDir))
            {
                var info = ReadPack(bookId, Path.GetFileName(voiceDir));
                if (info != null) list.Add((bookId, info));
            }
        }
        return list;
    }

    public static long DirSize(string dir)
    {
        try { return Directory.Exists(dir) ? new DirectoryInfo(dir).EnumerateFiles("*.oga").Sum(f => f.Length) : 0; }
        catch { return 0; }
    }

    public static long TotalBytes()
    {
        try { return new DirectoryInfo(Root).EnumerateFiles("*.oga", SearchOption.AllDirectories).Sum(f => f.Length); }
        catch { return 0; }
    }

    // ---------- «Освободить место» (настройки) ----------

    static long FileSize(string p) { try { return new FileInfo(p).Length; } catch { return 0; } }

    /// <summary>Папки книг со скачанной озвучкой (их имена — номера книг).</summary>
    public static List<string> BookIds()
    {
        try { return Directory.GetDirectories(Root).Select(d => Path.GetFileName(d)!).ToList(); }
        catch { return []; }
    }

    public static List<string> VoicesOf(string bookId)
    {
        try { return Directory.Exists(BookDir(bookId)) ? Directory.GetDirectories(BookDir(bookId)).Select(d => Path.GetFileName(d)!).ToList() : []; }
        catch { return []; }
    }

    public static long BookBytes(string bookId)
    {
        try { return Directory.Exists(BookDir(bookId)) ? new DirectoryInfo(BookDir(bookId)).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length) : 0; }
        catch { return 0; }
    }

    /// <summary>Устаревшие фразы набора и их размер: (ключи, байты).</summary>
    public static (List<string> Keys, long Bytes) OutdatedFiles(string bookId, string voice)
    {
        var keys = OutdatedKeys(bookId, voice).ToList();
        return (keys, keys.Sum(k => FileSize(PathFor(bookId, voice, k))));
    }

    /// <summary>Недописанные файлы (.part, .tmp) — остались после обрыва.</summary>
    public static List<string> PartFiles()
    {
        try
        {
            return Directory.EnumerateFiles(Root, "*", SearchOption.AllDirectories)
                .Where(f => f.EndsWith(".part", StringComparison.Ordinal) || f.EndsWith(".tmp", StringComparison.Ordinal)).ToList();
        }
        catch { return []; }
    }

    /// <summary>Пересчитать статистику набора после удаления фраз.</summary>
    public static void Recount(string bookId, string voice)
    {
        var info = ReadPack(bookId, voice);
        if (info == null) return;
        int n;
        lock (idxLock) n = Index(bookId, voice).Count;
        info.Done = Math.Min(n, info.Total > 0 ? info.Total : n);
        info.Bytes = DirSize(PackDir(bookId, voice));
        WritePack(bookId, info);
    }

    public static void DeletePack(string bookId, string voice) { TryDeleteDir(PackDir(bookId, voice)); ForgetIndex(PackDir(bookId, voice)); }
    public static void DeleteBook(string bookId) { TryDeleteDir(BookDir(bookId)); ForgetIndex(BookDir(bookId)); }
    public static void DeleteAll() { TryDeleteDir(Root); ForgetIndex(""); }

    static void TryDeleteDir(string d)
    {
        try { if (Directory.Exists(d)) Directory.Delete(d, true); } catch { }
    }
}
