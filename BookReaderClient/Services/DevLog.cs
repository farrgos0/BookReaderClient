namespace BookReaderClient.Services;

/// <summary>
/// Технический журнал подключения (поиск сервера, проверки). Пишется всегда, показывается только
/// на скрытом экране «Для разработчиков». Хранит последние строки в памяти.
/// </summary>
public static class DevLog
{
    const int Max = 500;
    static readonly List<string> lines = new();
    static readonly object sync = new();

    public static event Action<string>? Added;
    public static event Action? Cleared;

    public static void Write(string line)
    {
        var s = $"[{DateTime.Now:HH:mm:ss}] {line}";
        lock (sync)
        {
            lines.Add(s);
            if (lines.Count > Max) lines.RemoveRange(0, lines.Count - Max);
        }
        Added?.Invoke(s);
    }

    public static string[] Snapshot()
    {
        lock (sync) return lines.ToArray();
    }

    public static void Clear()
    {
        lock (sync) lines.Clear();
        Cleared?.Invoke();
    }
}
