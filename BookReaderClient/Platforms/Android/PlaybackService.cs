using Android.App;
using Android.Content;
using Android.Content.PM;
using Android.Graphics.Drawables;
using Android.Media;
using Android.Media.Session;
using Android.OS;
using BookReaderClient.Services;

namespace BookReaderClient;

/// <summary>
/// Фоновый сервис чтения: держит процесс живым при погашенном экране, показывает уведомление
/// с кнопками ⏮ ⏯ ⏭ ✕ и принимает кнопки гарнитуры/экрана блокировки (MediaSession).
/// </summary>
[Service(Exported = false, ForegroundServiceType = ForegroundService.TypeMediaPlayback)]
public class PlaybackService : Service
{
    const string ChannelId = "bookreader_playback";
    const int NotificationId = 1001;
    // команды кнопок уведомления: намерения адресованы прямо этой службе, поэтому имя пакета в них не нужно
    const string ActionToggle = "bookreader.action.TOGGLE";
    const string ActionNext = "bookreader.action.NEXT";
    const string ActionPrev = "bookreader.action.PREV";
    const string ActionStop = "bookreader.action.STOP";

    static PlaybackService? instance;
    MediaSession? session;

    static PlaybackEngine Engine => AppServices.Engine;

    /// <summary>Запустить сервис (или обновить уведомление, если уже работает).</summary>
    public static void EnsureRunning()
    {
        if (instance != null) { instance.Refresh(); return; }
        var ctx = global::Android.App.Application.Context;
        var intent = new Intent(ctx, typeof(PlaybackService));
        if (OperatingSystem.IsAndroidVersionAtLeast(26)) ctx.StartForegroundService(intent);
        else ctx.StartService(intent);
    }

    public override IBinder? OnBind(Intent? intent) => null;

    public override void OnCreate()
    {
        base.OnCreate();
        instance = this;
        CreateChannel();

        session = new MediaSession(this, "BookReader");
        session.SetCallback(new SessionCallback());
        session.Active = true;

        Engine.StateChanged += OnEngineState;
        Engine.SegmentChanged += OnEngineSegment;
        Engine.Ended += OnEngineEnded;
    }

    public override StartCommandResult OnStartCommand(Intent? intent, StartCommandFlags flags, int startId)
    {
        // startForeground нужно вызвать сразу после старта сервиса
        StartForegroundCompat(BuildNotification());
        switch (intent?.Action)
        {
            case ActionToggle: Engine.TogglePlayPause(); break;
            case ActionNext: Engine.Next(); break;
            case ActionPrev: Engine.Prev(); break;
            case ActionStop: Engine.Stop(); Shutdown(); break;
        }
        return StartCommandResult.NotSticky;
    }

    public override void OnDestroy()
    {
        Engine.StateChanged -= OnEngineState;
        Engine.SegmentChanged -= OnEngineSegment;
        Engine.Ended -= OnEngineEnded;
        session?.Release();
        session = null;
        instance = null;
        base.OnDestroy();
    }

    void OnEngineState(bool playing, bool loading) => Refresh();
    void OnEngineSegment(int index) => Refresh();
    void OnEngineEnded() => Refresh();

    void Refresh()
    {
        var playing = Engine.IsPlaying || Engine.IsLoading;
        UpdateSession(playing);
        var nm = (NotificationManager?)GetSystemService(NotificationService);
        nm?.Notify(NotificationId, BuildNotification());
    }

    void Shutdown()
    {
        if (OperatingSystem.IsAndroidVersionAtLeast(24)) StopForeground(StopForegroundFlags.Remove);
        StopSelf();
    }

    void StartForegroundCompat(Notification n)
    {
        if (OperatingSystem.IsAndroidVersionAtLeast(29)) StartForeground(NotificationId, n, ForegroundService.TypeMediaPlayback);
        else StartForeground(NotificationId, n);
    }

    void CreateChannel()
    {
        if (!OperatingSystem.IsAndroidVersionAtLeast(26)) return;
        var channel = new NotificationChannel(ChannelId, "Чтение вслух", NotificationImportance.Low)
        {
            Description = "Управление озвучкой книги",
        };
        channel.SetShowBadge(false);
        ((NotificationManager?)GetSystemService(NotificationService))?.CreateNotificationChannel(channel);
    }

    void UpdateSession(bool playing)
    {
        if (session == null) return;
        var state = new PlaybackState.Builder()
            .SetActions(PlaybackState.ActionPlay | PlaybackState.ActionPause | PlaybackState.ActionPlayPause |
                        PlaybackState.ActionSkipToNext | PlaybackState.ActionSkipToPrevious | PlaybackState.ActionStop)!
            .SetState(playing ? PlaybackStateCode.Playing : PlaybackStateCode.Paused, PlaybackState.PlaybackPositionUnknown, 1f)!
            .Build();
        session.SetPlaybackState(state);
        var meta = new MediaMetadata.Builder()
            .PutString(MediaMetadata.MetadataKeyTitle, string.IsNullOrEmpty(Engine.BookTitle) ? "BookReader" : Engine.BookTitle)!
            .PutString(MediaMetadata.MetadataKeyArtist, Short(Engine.CurrentText, 120))!
            .Build();
        session.SetMetadata(meta);
    }

    Notification BuildNotification()
    {
        var playing = Engine.IsPlaying || Engine.IsLoading;
        var builder = OperatingSystem.IsAndroidVersionAtLeast(26)
            ? new Notification.Builder(this, ChannelId)
            : new Notification.Builder(this);

        var open = PendingIntent.GetActivity(this, 0,
            new Intent(this, typeof(MainActivity)).SetFlags(ActivityFlags.SingleTop | ActivityFlags.ClearTop),
            PendingIntentFlags.Immutable | PendingIntentFlags.UpdateCurrent);

        builder
            .SetSmallIcon(global::Android.Resource.Drawable.IcMediaPlay)!
            .SetContentTitle(string.IsNullOrEmpty(Engine.BookTitle) ? "BookReader" : Engine.BookTitle)!
            .SetContentText(Short(Engine.CurrentText, 160))!
            .SetContentIntent(open)!
            .SetOngoing(playing)!
            .SetShowWhen(false)!
            .SetVisibility(NotificationVisibility.Public)!
            .AddAction(ActionButton(global::Android.Resource.Drawable.IcMediaPrevious, "Назад", ActionPrev, 1))!
            .AddAction(ActionButton(playing ? global::Android.Resource.Drawable.IcMediaPause : global::Android.Resource.Drawable.IcMediaPlay,
                playing ? "Пауза" : "Читать", ActionToggle, 2))!
            .AddAction(ActionButton(global::Android.Resource.Drawable.IcMediaNext, "Вперёд", ActionNext, 3))!
            .AddAction(ActionButton(global::Android.Resource.Drawable.IcMenuCloseClearCancel, "Стоп", ActionStop, 4));

        if (session != null)
        {
            var style = new Notification.MediaStyle();
            style.SetMediaSession(session.SessionToken);
            style.SetShowActionsInCompactView(0, 1, 2);
            builder.SetStyle(style);
        }
        return builder.Build()!;
    }

    Notification.Action ActionButton(int icon, string title, string action, int requestCode)
    {
        var pi = PendingIntent.GetService(this, requestCode,
            new Intent(this, typeof(PlaybackService)).SetAction(action),
            PendingIntentFlags.Immutable | PendingIntentFlags.UpdateCurrent);
        return new Notification.Action.Builder(Icon.CreateWithResource(this, icon), title, pi).Build()!;
    }

    static string Short(string s, int max) => string.IsNullOrEmpty(s) ? "" : s.Length <= max ? s : s[..max] + "…";

    /// <summary>Кнопки гарнитуры, экрана блокировки, Bluetooth.</summary>
    sealed class SessionCallback : MediaSession.Callback
    {
        public override void OnPlay() => Engine.Resume(Engine.Index);
        public override void OnPause() => Engine.Pause();
        public override void OnSkipToNext() => Engine.Next();
        public override void OnSkipToPrevious() => Engine.Prev();
        public override void OnStop() => Engine.Stop();
    }
}
