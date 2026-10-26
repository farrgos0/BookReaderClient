using System.Text.Json;
using BookReaderClient.Bridge;
using BookReaderClient.Services;

namespace BookReaderClient;

/// <summary>Читалка: тот же веб-интерфейс, что на ПК (папка web), внутри HybridWebView.</summary>
public class MainPage : ContentPage
{
    readonly HybridWebView web;
    bool settingsOpen;

    public MainPage()
    {
        NavigationPage.SetHasNavigationBar(this, false);
        BackgroundColor = Color.FromArgb("#F4EFE4");

        web = new HybridWebView
        {
            HybridRoot = "wwwroot",
            DefaultFile = "index.html",
        };
        web.SetInvokeJavaScriptTarget(new JsBridge(this));
        Content = web;
#if ANDROID
        web.HandlerChanged += (_, _) => ClearWebCacheAfterUpdate();
#endif

        // события нативного плеера → веб-часть (подсветка фразы, кнопка ▶/⏸, ошибки)
        var engine = AppServices.Engine;
        engine.SegmentChanged += i => Js($"window.__native&&__native.onSegment({i})");
        engine.StateChanged += (playing, loading) => Js($"window.__native&&__native.onState({B(playing)},{B(loading)})");
        engine.Error += msg => Js($"window.__native&&__native.onError({JsonSerializer.Serialize(msg)})");
        engine.Ended += () => Js("window.__native&&__native.onEnded()");
        engine.SleepFired += () => Js("window.__native&&__native.onSleep()");

        // скачивание озвучки: проценты → веб-часть; на Android — фоновая служба с уведомлением
        var preload = AppServices.Preload;
        preload.Changed += json => Js($"window.__native&&__native.onPreload({json})");
#if ANDROID
        preload.ActiveChanged += on => MainThread.BeginInvokeOnMainThread(() =>
        {
            if (on) DownloadService.Start(); else DownloadService.Stop();
        });
        preload.Changed += _ => DownloadService.Refresh();
#endif

        // отступы под строку состояния / кнопки навигации Android
        SystemBars.InsetsChanged += t => Padding = t;
    }

#if ANDROID
    /// <summary>
    /// Приложение обновили (новый APK или новая сборка из Visual Studio) — сбрасываем кэш WebView,
    /// чтобы веб-часть (app.js, pron.js…) не осталась от прошлой версии.
    /// </summary>
    void ClearWebCacheAfterUpdate()
    {
        try
        {
            if (web.Handler?.PlatformView is not Android.Webkit.WebView wv) return;
            var ctx = Android.App.Application.Context;
            var info = ctx.PackageManager?.GetPackageInfo(ctx.PackageName ?? "", 0);
            var stamp = info?.LastUpdateTime ?? 0;
            if (stamp == 0 || Preferences.Default.Get("web_cache_stamp", 0L) == stamp) return;
            wv.ClearCache(true);
            Preferences.Default.Set("web_cache_stamp", stamp);
            DevLog.Write("приложение обновлено — кэш веб-части сброшен");
        }
        catch (Exception ex) { CrashLog.Write("MainPage.ClearWebCache", ex); }
    }
#endif

    bool themeDark;

    /// <summary>Цвет фона под системными панелями = фон текущей темы читалки.</summary>
    public void ApplyTheme(string bgHex, bool dark)
    {
        MainThread.BeginInvokeOnMainThread(() =>
        {
            try { BackgroundColor = Color.FromArgb(bgHex); } catch { }
            themeDark = dark;
            SystemBars.SetDark(dark);
        });
    }

    public void RestoreSystemBars() => SystemBars.SetDark(themeDark);

    static string B(bool v) => v ? "true" : "false";

    /// <summary>Выполнить JS в странице (из любого потока).</summary>
    public void Js(string code)
    {
        SafeRun.OnMain(async () =>
        {
            try { await web.EvaluateJavaScriptAsync(code); }
            catch (Exception ex) { System.Diagnostics.Debug.WriteLine("JS error: " + ex.Message); }
        }, "MainPage.Js");
    }

    /// <summary>Ответ на асинхронный вызов из JS (см. JsBridge.Run).</summary>
    public void Resolve(string reqId, string? json, string? error) =>
        Js($"window.__native&&__native.resolve({JsonSerializer.Serialize(reqId)},{JsonSerializer.Serialize(json)},{JsonSerializer.Serialize(error)})");

    public void OpenSettings(bool autoFind = false)
    {
        SafeRun.OnMain(async () =>
        {
            if (settingsOpen) return;
            settingsOpen = true;
            var page = new SettingsPage(autoFind);
            page.Disappearing += (_, _) =>
            {
                settingsOpen = false;
                if (page.Saved) Js("window.__native&&__native.onServerChanged()");
            };
            try { await Navigation.PushAsync(page); }
            catch (Exception ex) { settingsOpen = false; CrashLog.Write("OpenSettings", ex); }
        }, "MainPage.OpenSettings");
    }

    // ---------- кнопка «Назад» (Android) ----------
    // Сначала закрываем то, что открыто в читалке (окно, панель, меню, клавиатуру); выходим только двойным нажатием.
    long lastBack;

    protected override bool OnBackButtonPressed()
    {
        _ = HandleBackAsync();
        return true; // решаем сами, асинхронно (спрашиваем веб-часть)
    }

    async Task HandleBackAsync()
    {
        string? r = null;
        try { r = await web.EvaluateJavaScriptAsync("(window.__native && __native.onBack) ? __native.onBack() : 'exit'"); }
        catch { }
        r = (r ?? "exit").Trim().Trim('"');
        if (r == "handled") return;

        var now = System.Environment.TickCount64;
        if (now - lastBack > 2000)
        {
            lastBack = now;
            Js("window.__native&&__native.toast('Нажмите «Назад» ещё раз, чтобы выйти')");
            return;
        }
        lastBack = 0;
        if (AppServices.Engine.IsPlaying || AppServices.Engine.IsLoading || AppServices.Preload.IsActive)
        {
#if ANDROID
            // идёт чтение или загрузка — не убиваем, а сворачиваем: всё продолжится в фоне
            Platform.CurrentActivity?.MoveTaskToBack(true);
            return;
#endif
        }
        Application.Current?.Quit();
    }

    bool crashShown;

    protected override void OnAppearing()
    {
        base.OnAppearing();
        if (!crashShown)
        {
            crashShown = true;
            // прошлый запуск закончился вылетом — сказать об этом (подробности в «Журнале сбоев»)
            var crash = CrashLog.TakeNew();
            if (crash != null)
                Dispatcher.DispatchDelayed(TimeSpan.FromSeconds(3), () =>
                    Js($"window.__native&&__native.toast({JsonSerializer.Serialize("Прошлый запуск завершился сбоем. Подробности: Настройки → Подключение к серверу → «Журнал сбоев»")})"));
        }
        SystemBars.Attach();
        Padding = SystemBars.Insets;
        RestoreSystemBars();
        // первый запуск (соглашение, предложение подключить сервер) показывает сама веб-часть
    }
}
