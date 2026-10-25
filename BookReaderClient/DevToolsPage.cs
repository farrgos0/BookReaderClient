using System.Collections.ObjectModel;
using BookReaderClient.Services;
using static BookReaderClient.Ui;

namespace BookReaderClient;

/// <summary>
/// Скрытый экран «Для разработчиков» (долгое нажатие на версию на экране подключения):
/// ping, TCP-порт, HTTP-запросы к серверу, тест синтеза, адреса устройства, версии, журнал сбоев.
/// Журнал — виртуализированный список (CollectionView) в своей строке сетки, без вложенной прокрутки:
/// новые строки появляются сразу, без «пустого блока до свайпа».
/// </summary>
public class DevToolsPage : ContentPage
{
    const int MaxLines = 500;
    readonly string raw;             // адрес сервера, который проверяем (введённый или сохранённый)
    readonly ObservableCollection<string> lines = new();
    readonly CollectionView logView;
    IAudioOutput? testOutput;
    bool scrollQueued;

    public DevToolsPage(string serverAddress)
    {
        raw = serverAddress ?? "";
        Title = "Для разработчиков";
        BackgroundColor = PageBg;
        NavigationPage.SetHasNavigationBar(this, false);

        foreach (var l in DevLog.Snapshot()) lines.Add(l);
        logView = new CollectionView
        {
            ItemsSource = lines,
            ItemsUpdatingScrollMode = ItemsUpdatingScrollMode.KeepLastItemInView,
            SelectionMode = SelectionMode.None,
            ItemTemplate = new DataTemplate(() =>
            {
                var l = new Label { FontFamily = MonoFont, FontSize = 12.5, TextColor = Ink, LineBreakMode = LineBreakMode.WordWrap, Padding = new Thickness(0, 1) };
                l.SetBinding(Label.TextProperty, ".");
                return l;
            }),
            EmptyView = new Label { Text = "Журнал пуст. Нажмите любую проверку.", TextColor = Muted, FontSize = 13, Margin = new Thickness(0, 8) },
        };

        var tools = new FlexLayout { Wrap = Microsoft.Maui.Layouts.FlexWrap.Wrap, JustifyContent = Microsoft.Maui.Layouts.FlexJustify.Start };
        foreach (var b in new[]
        {
            Small("Ping ×4", Guard(PingAsync)),
            Small("TCP-порт", Guard(TcpAsync)),
            Small("HTTP /api/ping", Guard(HttpPingAsync)),
            Small("Голоса /api/info", Guard(InfoAsync)),
            Small("Тест синтеза", Guard(SynthTestAsync)),
            Small("IP устройства", Guard(MyIpAsync)),
            Small("Версии", Guard(VersionsAsync)),
            Small("Журнал сбоев", Guard(() => { Write(CrashLog.Read() ?? "сбоев не было"); return Task.CompletedTask; })),
            Small("Копировать журнал", Guard(CopyAsync)),
            Small("Очистить", Guard(() => { DevLog.Clear(); return Task.CompletedTask; })),
        }) tools.Children.Add(b);

        var top = new VerticalStackLayout
        {
            Padding = new Thickness(16, 12, 16, 4),
            Spacing = 8,
            Children =
            {
                Hint("Сервер: " + (AppSettings.NormalizeBaseUrl(raw) is { Length: > 0 } u ? u : "не задан")),
                tools,
            },
        };
        var logCard = Card(logView);
        logCard.Margin = new Thickness(16, 0, 16, 12);

        var root = new Grid
        {
            RowDefinitions = { new RowDefinition(GridLength.Auto), new RowDefinition(GridLength.Auto), new RowDefinition(GridLength.Star) },
        };
        root.Add(TitleBar("Для разработчиков", CloseAsync), 0, 0);
        root.Add(top, 0, 1);
        root.Add(logCard, 0, 2);
        Content = root;
    }

    // ---------- журнал ----------

    protected override void OnAppearing()
    {
        base.OnAppearing();
        Padding = SystemBars.Insets;
        SystemBars.InsetsChanged += OnInsets;
        DevLog.Added += OnAdded;
        DevLog.Cleared += OnCleared;
        ScrollToEnd();
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        SystemBars.InsetsChanged -= OnInsets;
        DevLog.Added -= OnAdded;
        DevLog.Cleared -= OnCleared;
        testOutput?.Stop();
    }

    void OnInsets(Thickness t) => Padding = t;

    void OnAdded(string line) => MainThread.BeginInvokeOnMainThread(() =>
    {
        lines.Add(line);
        while (lines.Count > MaxLines) lines.RemoveAt(0);
        ScrollToEnd();
    });

    void OnCleared() => MainThread.BeginInvokeOnMainThread(lines.Clear);

    /// <summary>
    /// Прокрутка к последней строке — после того как список разложит новые строки (следующий кадр).
    /// Несколько строк подряд — одна прокрутка.
    /// </summary>
    void ScrollToEnd()
    {
        if (scrollQueued || lines.Count == 0) return;
        scrollQueued = true;
        Dispatcher.Dispatch(() =>
        {
            scrollQueued = false;
            try { if (lines.Count > 0) logView.ScrollTo(lines.Count - 1, position: ScrollToPosition.End, animate: false); }
            catch (Exception ex) { System.Diagnostics.Debug.WriteLine("log scroll: " + ex.Message); }
        });
    }

    static void Write(string line) => DevLog.Write(line);

    Func<Task> Guard(Func<Task> action) => async () =>
    {
        try { await action(); }
        catch (Exception ex) { Write("ошибка: " + Err(ex)); }
    };

    string Url => AppSettings.NormalizeBaseUrl(raw);

    string Err(Exception ex) =>
        TtsClient.Friendly(ex, Url) + $"  [{(ex.InnerException ?? ex).GetType().Name}: {(ex.InnerException ?? ex).Message}]";

    Task CloseAsync() => Navigation.NavigationStack.Count > 1 && Navigation.NavigationStack[^1] == this
        ? Navigation.PopAsync()
        : Task.CompletedTask;

    // ---------- проверки ----------

    async Task PingAsync()
    {
        var (host, _) = AppSettings.HostPort(raw);
        Write($"=== ping {host} ===");
        await foreach (var line in NetTools.PingAsync(host)) Write(line);
    }

    async Task TcpAsync()
    {
        var (host, port) = AppSettings.HostPort(raw);
        Write(await NetTools.TcpCheckAsync(host, port));
    }

    async Task HttpPingAsync()
    {
        Write($"=== GET {Url}/api/ping ===");
        var (json, time) = await AppServices.Tts.PingAsync(Url);
        Write($"{time.TotalMilliseconds:0} мс → {json}");
    }

    async Task InfoAsync()
    {
        Write($"=== GET {Url}/api/info ===");
        Write(await AppServices.Tts.InfoAsync(baseUrl: Url));
    }

    async Task SynthTestAsync()
    {
        Write($"=== POST {Url}/api/tts ===");
        // случайное число — чтобы сервер не отдал готовое из своего кеша и замер был честным
        var text = $"Проверка связи номер {Random.Shared.Next(100, 999)}. Сервер озвучки работает, и это предложение нужно, чтобы замерить скорость синтеза.";
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var bytes = await AppServices.Tts.SynthAsync(text, "aidar", 0.2, baseUrl: Url);
        var ms = Math.Max(1, sw.ElapsedMilliseconds);
        var path = Path.Combine(FileSystem.CacheDirectory, "synth_test.audio");
        await File.WriteAllBytesAsync(path, bytes);
        var fmt = bytes.Length > 4 && bytes[0] == 'O' ? "Opus" : "WAV";
        var pcm = Wav.Read(path);
        var sec = pcm.Data.Length / 2.0 / pcm.Channels / pcm.SampleRate;
        Write($"получено {bytes.Length / 1024.0:0.#} КБ ({fmt}) за {ms} мс; звука {sec:0.0} с");
        Write($"скорость: в {sec * 1000 / ms:0.#} раз быстрее реального времени (вместе с сетью) — проигрываю");
        if (fmt == "WAV") Write("сервер отдаёт WAV: на ПК нет ffmpeg — запустите BookReader.bat, он поставит imageio-ffmpeg");
        testOutput?.Stop();
        testOutput = AppServices.CreateOutput();
        testOutput.Enqueue(path, 0);
    }

    Task MyIpAsync()
    {
        Write("=== адреса устройства ===");
        foreach (var a in NetTools.LocalAddresses()) Write(a);
        Write("ПК и телефон должны быть в одной подсети (первые три числа адреса совпадают) или в одной VPN.");
        return Task.CompletedTask;
    }

    Task VersionsAsync()
    {
        Write("=== версии ===");
        Write($"приложение: {AppInfo.Current.VersionString} ({AppInfo.Current.BuildString}), {DeviceInfo.Current.Platform} {DeviceInfo.Current.VersionString}");
        try
        {
            var v = LibraryStore.SqliteVersion();
            var ok = Version.TryParse(v, out var ver) && ver >= new Version(3, 50, 2);
            Write($"SQLite: {v} — {(ok ? "исправление CVE-2025-6965 есть" : "СТАРАЯ версия, нужна 3.50.2+")}");
        }
        catch (Exception ex) { Write("SQLite: не удалось определить — " + ex.Message); }
        Write($"сервер: {(AppSettings.HasServer ? AppSettings.BaseUrl : "не задан")}");
        // путь к данным не показываем: в нём идентификатор сборки (имя пакета) — журнал могут скопировать и отправить
        try { Write($"загруженная озвучка: {AudioStore.TotalBytes() / 1048576.0:0.#} МБ"); } catch { }
        return Task.CompletedTask;
    }

    async Task CopyAsync()
    {
        await Clipboard.Default.SetTextAsync(string.Join("\n", DevLog.Snapshot()));
        Write("журнал скопирован в буфер обмена");
    }
}
