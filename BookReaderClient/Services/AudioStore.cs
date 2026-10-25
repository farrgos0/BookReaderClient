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
            foreach (var k in index.Keys.Where(k => k.StartsWith(dirPrefix, StringComparison.Ordinal)).ToList()) index.Remove(k);
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

    public static void DeletePack(string bookId, string voice) { TryDeleteDir(PackDir(bookId, voice)); ForgetIndex(PackDir(bookId, voice)); }
    public static void DeleteBook(string bookId) { TryDeleteDir(BookDir(bookId)); ForgetIndex(BookDir(bookId)); }
    public static void DeleteAll() { TryDeleteDir(Root); ForgetIndex(""); }

    static void TryDeleteDir(string d)
    {
        try { if (Directory.Exists(d)) Directory.Delete(d, true); } catch { }
    }
}
