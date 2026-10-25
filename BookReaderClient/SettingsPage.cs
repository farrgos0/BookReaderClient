using System.Text.Json;
using BookReaderClient.Services;
using static BookReaderClient.Ui;

namespace BookReaderClient;

/// <summary>
/// Подключение к серверу озвучки: статус сервера, «Проверить соединение», «Найти сервер», адрес вручную.
/// Технические проверки (ping, TCP, журнал) — на скрытом экране <see cref="DevToolsPage"/>:
/// долгое нажатие на строку версии внизу (или 5 нажатий подряд).
/// </summary>
public class SettingsPage : ContentPage
{
    readonly Entry address;
    readonly Label status;            // что происходит сейчас: «Проверяю…», «Ищу сервер…», ошибки
    readonly Label stateDot, stateTitle, stateDetails;
    readonly Button find;
    readonly VerticalStackLayout foundList = new() { Spacing = 8 };
    readonly bool autoFind;
    CancellationTokenSource? findCts;

    public bool Saved { get; private set; }

    /// <param name="autoFind">сразу начать поиск сервера в сети (первый запуск, кнопка «Подключить сервер»)</param>
    public SettingsPage(bool autoFind = false)
    {
        this.autoFind = autoFind;
        HideSoftInputOnTapped = true; // клавиатура прячется по нажатию на свободное место
        Title = "Подключение к серверу";
        BackgroundColor = PageBg;
        NavigationPage.SetHasNavigationBar(this, false);

        // ---- статус сервера ----
        stateDot = new Label { Text = "●", FontSize = 22, VerticalOptions = LayoutOptions.Center };
        stateTitle = new Label { FontSize = 19, FontAttributes = FontAttributes.Bold, TextColor = Ink, VerticalOptions = LayoutOptions.Center };
        stateDetails = new Label { FontSize = 14, TextColor = Muted, LineBreakMode = LineBreakMode.WordWrap };
        var stateHead = new HorizontalStackLayout { Spacing = 10, Children = { stateDot, stateTitle } };
        var stateCard = Card(new VerticalStackLayout { Spacing = 4, Children = { stateHead, stateDetails } });

        var check = Primary("Проверить соединение", CheckSavedOrEnteredAsync);
        find = Secondary("Найти сервер в сети", FindAsync);
        status = new Label { FontSize = 14.5, TextColor = Muted, LineBreakMode = LineBreakMode.WordWrap };

        // ---- адрес вручную ----
        address = new Entry
        {
            Text = AppSettings.Server,
            Placeholder = "IP-адрес или имя ПК",
            Keyboard = Keyboard.Url,
            FontSize = 18,
            ClearButtonVisibility = ClearButtonVisibility.WhileEditing,
            TextColor = Colors.Black,
        };
        address.Completed += (_, _) => SafeRun.Fire(async () =>
        {
            address.Unfocus();
            if (await CheckAsync(address.Text ?? "")) await SaveAsync();
        }, "SettingsPage.Address");
        var save = Secondary("Проверить и сохранить", async () =>
        {
            if (await CheckAsync(address.Text ?? "")) await SaveAsync();
        });

        // ---- версия: долгое нажатие (или 5 нажатий) — инструменты разработчика ----
        var version = new Label
        {
            Text = $"BookReader {AppInfo.Current.VersionString} (сборка {AppInfo.Current.BuildString})",
            FontSize = 12.5, TextColor = Muted, HorizontalOptions = LayoutOptions.Center, Margin = new Thickness(0, 24, 0, 8),
            Padding = new Thickness(16, 10),
        };
        WireDevGesture(version);

        var body = new ScrollView
        {
            Content = new VerticalStackLayout
            {
                Padding = new Thickness(20, 16),
                Spacing = 12,
                MaximumWidthRequest = 720,
                Children =
                {
                    Header("Сервер озвучки"),
                    stateCard,
                    new FlexLayout { Wrap = Microsoft.Maui.Layouts.FlexWrap.Wrap, Children = { Spaced(check), find } },
                    status,
                    foundList,
                    Header("Адрес вручную"),
                    Hint("Если поиск не находит сервер: IP-адрес или имя ПК, где запущен BookReader. Адрес сервер показывает в своём окне " +
                         "при запуске. Порт можно не указывать. Вне дома подойдёт адрес ПК в вашей VPN."),
                    Card(address),
                    save,
                    version,
                },
            },
        };

        var root = new Grid { RowDefinitions = { new RowDefinition(GridLength.Auto), new RowDefinition(GridLength.Star) } };
        root.Add(TitleBar("Подключение к серверу", CloseAsync), 0, 0);
        root.Add(body, 0, 1);
        Content = root;
        SystemBars.InsetsChanged += OnInsets;
        ShowState(AppSettings.HasServer ? State.Unknown : State.NotSet, AppSettings.HasServer ? AppSettings.BaseUrl : "");
    }

    static View Spaced(View v) { v.Margin = new Thickness(0, 0, 10, 8); return v; }

    void OnInsets(Thickness t) => Padding = t;

    bool started;
    protected override void OnAppearing()
    {
        base.OnAppearing();
        Padding = SystemBars.Insets;
        SystemBars.SetDark(false);
        inDevTools = false;   // вернулись с экрана разработчика
        if (started) return;
        started = true;
        if (autoFind) SafeRun.Fire(FindAsync, "SettingsPage.AutoFind");
        else if (AppSettings.HasServer) SafeRun.Fire(() => CheckAsync(AppSettings.Server), "SettingsPage.AutoCheck"); // статус сразу при открытии
    }

    // ---------- статус ----------

    enum State { NotSet, Unknown, Checking, Online, Offline }

    void ShowState(State s, string addr, string? name = null, string? version = null, string? device = null, string? problem = null) =>
        MainThread.BeginInvokeOnMainThread(() =>
        {
            (stateDot.TextColor, stateTitle.Text) = s switch
            {
                State.Online => (Ok, "Онлайн"),
                State.Offline => (Bad, "Не отвечает"),
                State.Checking => (Colors.Gray, "Проверяю…"),
                State.NotSet => (Colors.Gray, "Сервер не выбран"),
                _ => (Colors.Gray, "Не проверен"),
            };
            var lines = new List<string>();
            if (s == State.NotSet) lines.Add("Нажмите «Найти сервер в сети» — приложение найдёт компьютер с запущенным BookReader.");
            if (!string.IsNullOrEmpty(name)) lines.Add(name);
            if (!string.IsNullOrEmpty(addr)) lines.Add("Адрес: " + addr);
            if (!string.IsNullOrEmpty(version)) lines.Add("Версия сервера: " + version + (string.IsNullOrEmpty(device) ? "" : " · синтез на " + device));
            if (!string.IsNullOrEmpty(problem)) lines.Add(problem);
            stateDetails.Text = string.Join("\n", lines);
            stateDetails.IsVisible = lines.Count > 0;
        });

    static string DeviceName(string? d) => d switch
    {
        "cuda" => "видеокарте",
        "cpu" => "процессоре",
        "fake" => "тестовом движке",
        null or "" => "",
        _ => d,
    };

    void SetStatus(string text, Color color) => MainThread.BeginInvokeOnMainThread(() =>
    {
        status.Text = text;
        status.TextColor = color;
        status.IsVisible = text.Length > 0;
    });

    // ---------- проверка соединения ----------

    string lastProblem = "";   // почему не прошла последняя проверка — коротко, для сообщения «Сервер не отвечает»

    Task CheckSavedOrEnteredAsync()
    {
        var raw = (address.Text ?? "").Trim();
        return CheckAsync(raw.Length > 0 ? raw : AppSettings.Server);
    }

    /// <summary>Сервер по адресу raw отвечает? Обновляет карточку статуса. Подробности — в техническом журнале.</summary>
    async Task<bool> CheckAsync(string raw)
    {
        HideKeyboard();
        var url = AppSettings.NormalizeBaseUrl(raw);
        if (url.Length == 0)
        {
            ShowState(State.NotSet, "");
            SetStatus("Адрес сервера не задан: найдите сервер в сети или введите адрес ниже.", Bad);
            return false;
        }
        ShowState(State.Checking, url);
        SetStatus("", Colors.Gray);
        DevLog.Write($"=== проверка {url} ===");
        var (host, port) = AppSettings.HostPort(raw);
        lastProblem = "";
        var tcp = await NetTools.TcpCheckAsync(host, port);
        DevLog.Write(tcp);
        if (!tcp.Contains("порт открыт"))
        {
            lastProblem = tcp[(tcp.IndexOf('—') + 1)..].Trim();
            ShowState(State.Offline, url, problem: Explain(lastProblem));
            return false;
        }
        try
        {
            var (json, time) = await AppServices.Tts.PingAsync(url);
            DevLog.Write($"HTTP /api/ping: {time.TotalMilliseconds:0} мс → {json}");
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            string Str(string k) => r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
            var host2 = Str("host");
            ShowState(State.Online, url, host2.Length > 0 ? $"BookReader ({host2})" : "BookReader", Str("version"), DeviceName(Str("device")));
            return true;
        }
        catch (Exception ex)
        {
            DevLog.Write("ошибка: " + TechError(ex, url));
            lastProblem = ex is TaskCanceledException or TimeoutException ? "не ответил за 5 с" : TtsClient.Friendly(ex, url);
            ShowState(State.Offline, url, problem: "Порт открыт, но " + lastProblem);
            return false;
        }
    }

    /// <summary>Причина из TCP-проверки → понятная подсказка, что делать.</summary>
    static string Explain(string tcpReason) =>
        tcpReason.Contains("отказ") ? "Компьютер доступен, но BookReader на нём не запущен. Запустите BookReader на ПК."
        : tcpReason.Contains("нет ответа") ? "Компьютер не отвечает: он выключен, в другой сети или брандмауэр Windows не пускает подключения."
        : tcpReason;

    static string TechError(Exception ex, string url) =>
        TtsClient.Friendly(ex, url) + $"  [{(ex.InnerException ?? ex).GetType().Name}: {(ex.InnerException ?? ex).Message}]";

    // ---------- поиск сервера в сети ----------

    int findGen;          // номер текущего поиска: результаты прежних (отменённых) поисков игнорируются
    bool usingServer;     // идёт «проверить и сохранить» найденный сервер
    bool closing;         // страница уже закрывается
    List<ServerDiscovery.Found> lastFound = [];

    async Task FindAsync()
    {
        HideKeyboard();
        var my = ++findGen;
        findCts?.Cancel();
        var cts = findCts = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        foundList.Children.Clear();
        find.Text = "Найти сервер заново";
        SetStatus("Ищу сервер BookReader в сети…", Colors.Gray);
        DevLog.Write("=== поиск сервера в сети ===");
        var progress = new Progress<string>(m =>
        {
            if (my != findGen || closing) return;
            DevLog.Write(m);
            if (m.StartsWith("проверено")) SetStatus("Ищу сервер: " + m, Colors.Gray);
        });
        List<ServerDiscovery.Found> found;
        try { found = await ServerDiscovery.FindAsync(progress, cts.Token); }
        catch (OperationCanceledException) { return; } // поиск перезапустили или ушли со страницы
        catch (Exception ex)
        {
            if (my == findGen && !closing) SetStatus("Поиск не удался: " + TtsClient.Friendly(ex), Bad);
            return;
        }
        // пока искали, могли нажать «Найти» ещё раз или закрыть страницу — тогда этот результат уже не нужен
        if (my != findGen || closing || cts.IsCancellationRequested) return;

        if (found.Count == 0)
        {
            SetStatus("Сервер в сети не найден. Проверьте, что на ПК запущен BookReader, телефон в той же сети " +
                      "(Wi-Fi или точка доступа), а брандмауэр Windows разрешает Python. Адрес можно ввести вручную.", Bad);
            return;
        }
        lastFound = found;
        foreach (var f in found) DevLog.Write("найден: " + f.Title + (f.Version.Length > 0 ? $" (v{f.Version})" : ""));
        if (found.Count == 1)
        {
            await UseAsync(found[0]);   // один сервер — подключаемся сразу
            return;
        }
        // несколько серверов — не угадываем, а спрашиваем; список остаётся и на странице, если окно закрыть
        ShowFound(found, $"Найдено серверов: {found.Count}. Выберите нужный:", Ok);
        string? pick;
        try
        {
            pick = await DisplayActionSheetAsync($"Найдено серверов: {found.Count}. Какой использовать?", "Отмена", null,
                found.Select(FoundLabel).ToArray());
        }
        catch (Exception ex) { CrashLog.Write("SettingsPage.PickServer", ex); return; }
        if (my != findGen || closing) return;
        var chosen = found.FirstOrDefault(f => FoundLabel(f) == pick);
        if (chosen != null) await UseAsync(chosen);
    }

    static string FoundLabel(ServerDiscovery.Found f) => "🖥 " + f.Title + (f.Version.Length > 0 ? $"  (v{f.Version})" : "");

    void ShowFound(List<ServerDiscovery.Found> found, string text, Color color)
    {
        foundList.Children.Clear();
        SetStatus(text, color);
        if (found.Count < 2) return;
        foreach (var f in found)
        {
            var b = Secondary(FoundLabel(f), () => UseAsync(f));
            b.HorizontalOptions = LayoutOptions.Fill;
            foundList.Children.Add(b);
        }
    }

    async Task UseAsync(ServerDiscovery.Found f)
    {
        if (usingServer || closing) return;
        usingServer = true;
        try
        {
            findCts?.Cancel();
            address.Text = f.BaseUrl;
            foreach (var v in foundList.Children) if (v is Button b) b.IsEnabled = false; // пока проверяем — второй не выбрать
            if (await CheckAsync(f.BaseUrl)) { await SaveAsync(); return; } // проверка прошла — сохраняем и возвращаемся в читалку
            if (closing) return;
            // сервер ответил на поиск, но сейчас молчит (ПК выключили, ушёл из сети, закрыли BookReader)
            var others = lastFound.Where(x => x.BaseUrl != f.BaseUrl).ToList();
            ShowFound(lastFound, $"Сервер «{f.Name}» не отвечает. " +
                (others.Count > 0 ? "Выберите другой сервер или повторите поиск." : "Повторите поиск."), Bad);
        }
        finally
        {
            usingServer = false;
            foreach (var v in foundList.Children) if (v is Button b) b.IsEnabled = true;
        }
    }

    // ---------- сохранение и выход ----------

    async Task SaveAsync()
    {
        if (closing) return;
        var raw = (address.Text ?? "").Trim();
        if (AppSettings.NormalizeBaseUrl(raw).Length == 0) { SetStatus("Адрес не распознан", Bad); return; }
        AppSettings.Server = raw;
        Saved = true;
        SetStatus("Сохранено — возвращаюсь в читалку", Ok);
        await Task.Delay(400);
        await CloseAsync();
    }

    /// <summary>Закрыть страницу ровно один раз и только если она сверху (иначе PopAsync снимет главный экран).</summary>
    async Task CloseAsync()
    {
        if (closing) return;
        closing = true;
        findCts?.Cancel();
        try
        {
            if (Navigation.NavigationStack.Count > 1 && Navigation.NavigationStack[^1] == this)
                await Navigation.PopAsync();
        }
        catch (Exception ex) { CrashLog.Write("SettingsPage.Close", ex); }
    }

    // ---------- скрытый вход в инструменты разработчика ----------

    int taps;
    long firstTap;
    CancellationTokenSource? pressCts;

    void WireDevGesture(Label version)
    {
        // 5 нажатий подряд (за 3 с)
        var tap = new TapGestureRecognizer();
        tap.Tapped += (_, _) =>
        {
            var now = System.Environment.TickCount64;
            if (now - firstTap > 3000) { firstTap = now; taps = 0; }
            if (++taps >= 5) { taps = 0; OpenDevTools(); }
        };
        version.GestureRecognizers.Add(tap);
        // долгое нажатие (0,8 с)
        var press = new PointerGestureRecognizer();
        press.PointerPressed += (_, _) =>
        {
            pressCts?.Cancel();
            var cts = pressCts = new CancellationTokenSource();
            SafeRun.Fire(async () =>
            {
                await Task.Delay(800, cts.Token);
                OpenDevTools();
            }, "SettingsPage.LongPress");
        };
        press.PointerReleased += (_, _) => pressCts?.Cancel();
        press.PointerExited += (_, _) => pressCts?.Cancel();
        version.GestureRecognizers.Add(press);
    }

    bool inDevTools;   // поверх открыт экран разработчика — эта страница не закрывается
    void OpenDevTools() => SafeRun.OnMain(async () =>
    {
        if (inDevTools || closing || Navigation.NavigationStack[^1] != this) return;
        inDevTools = true;
        try
        {
            var raw = (address.Text ?? "").Trim();
            await Navigation.PushAsync(new DevToolsPage(raw.Length > 0 ? raw : AppSettings.Server));
        }
        catch { inDevTools = false; throw; }
    }, "SettingsPage.DevTools");

    void HideKeyboard()
    {
        if (address.IsFocused) address.Unfocus();
#if ANDROID
        try { _ = address.HideSoftInputAsync(CancellationToken.None); } catch { }
#endif
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        HideKeyboard();
        if (inDevTools) return;   // поверх открылся экран разработчика — страница остаётся, поиск не прерываем
        closing = true;
        findCts?.Cancel();
        SystemBars.InsetsChanged -= OnInsets;
    }
}
