namespace BookReaderClient.Services;

/// <summary>
/// Журнал сбоев: необработанные исключения пишутся в файл crash.log в памяти приложения,
/// чтобы «вылет без ошибки» можно было разобрать. Смотреть: Подключение к серверу → «Журнал сбоев».
/// </summary>
public static class CrashLog
{
    static readonly object sync = new();
    static string FilePath => Path.Combine(FileSystem.AppDataDirectory, "crash.log");
    const long MaxSize = 256 * 1024;

    /// <summary>Подписаться на все необработанные исключения (вызвать один раз при старте).</summary>
    public static void Install()
    {
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Write("необработанное исключение", e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) => { Write("исключение в фоновой задаче", e.Exception); e.SetObserved(); };
#if ANDROID
        global::Android.Runtime.AndroidEnvironment.UnhandledExceptionRaiser += (_, e) => Write("сбой Android", e.Exception);
#endif
    }

    public static void Write(string where, Exception? ex)
    {
        try
        {
            lock (sync)
            {
                var f = new FileInfo(FilePath);
                if (f.Exists && f.Length > MaxSize) f.Delete();
                File.AppendAllText(FilePath,
                    $"==== {DateTime.Now:yyyy-MM-dd HH:mm:ss} — {where} (версия {AppInfo.Current.VersionString}, {DeviceInfo.Current.Platform} {DeviceInfo.Current.VersionString})\n{ex}\n\n");
            }
        }
        catch { }
    }

    public static string? Read()
    {
        try { return File.Exists(FilePath) ? File.ReadAllText(FilePath) : null; }
        catch { return null; }
    }

    /// <summary>Последний сбой, если он случился после прошлого показа (для подсказки при запуске).</summary>
    public static string? TakeNew()
    {
        try
        {
            if (!File.Exists(FilePath)) return null;
            var stamp = File.GetLastWriteTimeUtc(FilePath).Ticks;
            if (Preferences.Default.Get("crashSeen", 0L) >= stamp) return null;
            Preferences.Default.Set("crashSeen", stamp);
            var text = File.ReadAllText(FilePath);
            var i = text.LastIndexOf("==== ", StringComparison.Ordinal);
            var last = i >= 0 ? text[i..] : text;
            var firstLines = string.Join(" ", last.Split('\n').Take(2)).Replace("====", "").Trim();
            return firstLines.Length > 300 ? firstLines[..300] + "…" : firstLines;
        }
        catch { return null; }
    }
}
