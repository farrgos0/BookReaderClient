using Android.Content;
using Android.Media;
using Android.OS;

namespace BookReaderClient.Services;

/// <summary>
/// Аудиокниги на Android: системный MediaPlayer. Часть книги — кусок файла библиотеки (setDataSource с смещением),
/// поэтому ZIP без сжатия не распаковывается. Скорость без изменения тембра — PlaybackParams.
/// Все вызовы MediaPlayer — в главном потоке (его события приходят туда же).
/// </summary>
public sealed class AndroidAbOutput : IAbOutput
{
    MediaPlayer? player;
    Java.IO.FileInputStream? stream;
    double rate = 1;

    public event Action? Completed;
    public event Action<string>? Failed;

    public Task LoadAsync(string path, long offset, long length, long positionMs) =>
        MainThread.InvokeOnMainThreadAsync(async () =>
        {
            ReleaseNow();
            if (!File.Exists(path)) throw new FileNotFoundException("файл аудиокниги не найден");
            var mp = new MediaPlayer();
            player = mp;
            mp.SetAudioAttributes(new AudioAttributes.Builder()
                .SetUsage(AudioUsageKind.Media)!
                .SetContentType(AudioContentType.Speech)!
                .Build()!);
            // процессор не засыпает, пока играет (экран погашен)
            mp.SetWakeMode(global::Android.App.Application.Context, WakeLockFlags.Partial);
            stream = new Java.IO.FileInputStream(path);
            mp.SetDataSource(stream.FD, offset, length);
            var ready = new TaskCompletionSource();
            mp.Prepared += (_, _) => ready.TrySetResult();
            mp.Error += (_, e) =>
            {
                e.Handled = true;
                var msg = $"не получилось воспроизвести файл (код {(int)e.What}/{e.Extra}) — возможно, формат не поддерживается этим телефоном или файл повреждён";
                if (!ready.TrySetException(new InvalidOperationException(msg))) Failed?.Invoke(msg);
            };
            mp.Completion += (_, _) => { if (ReferenceEquals(player, mp)) Completed?.Invoke(); };
            mp.PrepareAsync();
            await ready.Task;
            if (!ReferenceEquals(player, mp)) return;
            if (positionMs > 0) SeekNow(mp, positionMs);
        });

    static void SeekNow(MediaPlayer mp, long ms)
    {
        // точная перемотка (Android 8+); раньше — до ближайшего ключевого кадра
        if (OperatingSystem.IsAndroidVersionAtLeast(26)) mp.SeekTo(ms, MediaPlayerSeekMode.Closest);
        else mp.SeekTo((int)Math.Min(int.MaxValue, ms));
    }

    public void Play(double r) => MainThread.BeginInvokeOnMainThread(() =>
    {
        var mp = player;
        if (mp == null) return;
        rate = r;
        try
        {
            // скорость задаётся перед стартом: на части телефонов смена PlaybackParams на паузе сама запускает звук
            if (OperatingSystem.IsAndroidVersionAtLeast(23))
                mp.PlaybackParams = (mp.PlaybackParams ?? new PlaybackParams()).SetSpeed((float)rate).SetPitch(1f);
            mp.Start();
            PlaybackService.EnsureRunning();   // уведомление и работа в фоне
        }
        catch (Exception ex) { Failed?.Invoke(ex.Message); }
    });

    public void Pause() => MainThread.BeginInvokeOnMainThread(() =>
    {
        try { if (player is { IsPlaying: true } mp) mp.Pause(); } catch { }
    });

    public void SeekMs(long ms) => MainThread.BeginInvokeOnMainThread(() =>
    {
        try { if (player != null) SeekNow(player, ms); } catch { }
    });

    public long PositionMs
    {
        get { try { return player?.CurrentPosition ?? 0; } catch { return 0; } }
    }

    public void SetRate(double r) => MainThread.BeginInvokeOnMainThread(() =>
    {
        rate = r;
        try
        {
            if (player is { IsPlaying: true } mp && OperatingSystem.IsAndroidVersionAtLeast(23))
                mp.PlaybackParams = (mp.PlaybackParams ?? new PlaybackParams()).SetSpeed((float)rate).SetPitch(1f);
        }
        catch { }
    });

    public void Release() => MainThread.BeginInvokeOnMainThread(ReleaseNow);

    void ReleaseNow()
    {
        var mp = player;
        player = null;
        try { mp?.Release(); } catch { }
        try { stream?.Close(); } catch { }
        stream = null;
    }
}
