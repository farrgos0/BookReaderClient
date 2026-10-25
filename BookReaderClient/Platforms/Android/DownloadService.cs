using Android.App;
using Android.Content;
using Android.Content.PM;
using Android.OS;
using BookReaderClient.Services;

namespace BookReaderClient;

/// <summary>
/// Фоновая служба на время скачивания озвучки: не даёт Android усыпить загрузку,
/// когда экран погашен или приложение свёрнуто, и показывает прогресс в уведомлении.
/// </summary>
[Service(Exported = false, ForegroundServiceType = ForegroundService.TypeDataSync)]
public class DownloadService : Service
{
    const string ChannelId = "bookreader_download";
    const int NotificationId = 1002;
    const string ActionCancel = "bookreader.action.DL_CANCEL"; // намерение адресовано этой службе — без имени пакета

    static DownloadService? instance;
    static long lastRefresh;
    PowerManager.WakeLock? wake;

    static PreloadManager Preload => AppServices.Preload;

    public static void Start()
    {
        if (instance != null) { instance.Update(); return; }
        var ctx = global::Android.App.Application.Context;
        var intent = new Intent(ctx, typeof(DownloadService));
        try
        {
            if (OperatingSystem.IsAndroidVersionAtLeast(26)) ctx.StartForegroundService(intent);
            else ctx.StartService(intent);
        }
        catch (Exception ex)
        {
            // например, запуск из фона запрещён — загрузка всё равно идёт, пока приложение открыто
            System.Diagnostics.Debug.WriteLine("DownloadService: " + ex.Message);
        }
    }

    public static void Stop() => instance?.Shutdown();

    /// <summary>Обновить уведомление (не чаще раза в секунду).</summary>
    public static void Refresh()
    {
        var now = System.Environment.TickCount64;
        if (instance == null || now - lastRefresh < 1000) return;
        lastRefresh = now;
        MainThread.BeginInvokeOnMainThread(() => instance?.Update());
    }

    public override IBinder? OnBind(Intent? intent) => null;

    public override void OnCreate()
    {
        base.OnCreate();
        instance = this;
        if (OperatingSystem.IsAndroidVersionAtLeast(26))
        {
            var channel = new NotificationChannel(ChannelId, "Скачивание озвучки", NotificationImportance.Low)
            {
                Description = "Прогресс загрузки озвучки книг",
            };
            channel.SetShowBadge(false);
            ((NotificationManager?)GetSystemService(NotificationService))?.CreateNotificationChannel(channel);
        }
        try
        {
            var pm = (PowerManager?)GetSystemService(PowerService);
            wake = pm?.NewWakeLock(WakeLockFlags.Partial, "BookReader:download");
            wake?.Acquire();
        }
        catch { }
    }

    public override StartCommandResult OnStartCommand(Intent? intent, StartCommandFlags flags, int startId)
    {
        var n = Build();
        if (OperatingSystem.IsAndroidVersionAtLeast(29)) StartForeground(NotificationId, n, ForegroundService.TypeDataSync);
        else StartForeground(NotificationId, n);

        if (intent?.Action == ActionCancel) Preload.CancelAll(); // «Остановить» в уведомлении — очистить очередь
        if (!Preload.IsActive) Shutdown();
        return StartCommandResult.NotSticky;
    }

    public override void OnDestroy()
    {
        try { if (wake?.IsHeld == true) wake.Release(); } catch { }
        wake = null;
        instance = null;
        base.OnDestroy();
    }

    void Update()
    {
        if (!Preload.IsActive) return;
        ((NotificationManager?)GetSystemService(NotificationService))?.Notify(NotificationId, Build());
    }

    void Shutdown()
    {
        if (OperatingSystem.IsAndroidVersionAtLeast(24)) StopForeground(StopForegroundFlags.Remove);
        StopSelf();
    }

    Notification Build()
    {
        var builder = OperatingSystem.IsAndroidVersionAtLeast(26)
            ? new Notification.Builder(this, ChannelId)
            : new Notification.Builder(this);
        var open = PendingIntent.GetActivity(this, 0,
            new Intent(this, typeof(MainActivity)).SetFlags(ActivityFlags.SingleTop | ActivityFlags.ClearTop),
            PendingIntentFlags.Immutable | PendingIntentFlags.UpdateCurrent);
        var cancel = PendingIntent.GetService(this, 11,
            new Intent(this, typeof(DownloadService)).SetAction(ActionCancel),
            PendingIntentFlags.Immutable | PendingIntentFlags.UpdateCurrent);
        var pct = Preload.Percent;
        builder
            .SetSmallIcon(global::Android.Resource.Drawable.StatSysDownload)!
            .SetContentTitle("Скачивание озвучки")!
            .SetContentText(Preload.Summary)!
            .SetProgress(100, pct, false)!
            .SetContentIntent(open)!
            .SetOngoing(true)!
            .SetOnlyAlertOnce(true)!
            .SetShowWhen(false)!
            .AddAction(new Notification.Action.Builder(
                global::Android.Graphics.Drawables.Icon.CreateWithResource(this, global::Android.Resource.Drawable.IcMenuCloseClearCancel),
                "Остановить", cancel).Build());
        return builder.Build()!;
    }
}
