namespace BookReaderClient.Services;

/// <summary>Настройки приложения (адрес сервера озвучки).</summary>
public static class AppSettings
{
    public const int DefaultPort = 8765;
    const string ServerKey = "server";

    /// <summary>Как ввёл пользователь: «192.168.0.5», «192.168.0.5:8765», «http://my-pc:8765» (пример).</summary>
    public static string Server
    {
        get => Preferences.Default.Get(ServerKey, "");
        set => Preferences.Default.Set(ServerKey, (value ?? "").Trim());
    }

    public static bool HasServer => !string.IsNullOrWhiteSpace(Server);

    /// <summary>Режим «Без сервера»: в сеть не ходим, читаем только скачанную озвучку.</summary>
    public static bool Offline
    {
        get => Preferences.Default.Get("offline", false);
        set => Preferences.Default.Set("offline", value);
    }

    /// <summary>
    /// Режим работы: "online" — с сервером озвучки; "offline" — без сервера, только скачанная озвучка;
    /// "autonomous" — автономный режим (шаг 7): только чтение (и готовые аудиокниги, шаг 8), нейроозвучки нет,
    /// в сеть не ходим. «Без сервера» и «автономный» оба выключают сеть (Offline = true).
    /// </summary>
    public static string Mode
    {
        get
        {
            var m = Preferences.Default.Get("mode", "");
            return m is "online" or "offline" or "autonomous" ? m : (Offline ? "offline" : "online");
        }
        set
        {
            var m = value is "offline" or "autonomous" ? value : "online";
            Preferences.Default.Set("mode", m);
            Offline = m != "online";
        }
    }

    public static bool Autonomous => Mode == "autonomous";

    /// <summary>Базовый адрес вида http://адрес:8765 (без завершающего «/»).</summary>
    public static string BaseUrl => NormalizeBaseUrl(Server);

    public static string NormalizeBaseUrl(string raw)
    {
        var s = (raw ?? "").Trim().TrimEnd('/');
        if (s.Length == 0) return "";
        var hasScheme = s.Contains("://", StringComparison.Ordinal);
        var hostPart = hasScheme ? s[(s.IndexOf("://", StringComparison.Ordinal) + 3)..] : s;
        if (!hasScheme) s = "http://" + s;
        if (!Uri.TryCreate(s, UriKind.Absolute, out var uri)) return "";
        var b = new UriBuilder(uri);
        // порт не указан — подставляем порт BookReader
        if (!hostPart.Split('/')[0].Contains(':')) b.Port = DefaultPort;
        return b.Uri.GetLeftPart(UriPartial.Authority);
    }

    /// <summary>Хост и порт из введённого адреса — для ping / TCP-проверки.</summary>
    public static (string Host, int Port) HostPort(string raw)
    {
        var url = NormalizeBaseUrl(raw);
        if (url.Length == 0 || !Uri.TryCreate(url, UriKind.Absolute, out var u)) return ("", DefaultPort);
        return (u.Host, u.Port);
    }
}
