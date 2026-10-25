namespace BookReaderClient.Services;

/// <summary>Общие сервисы приложения (одни на процесс: их использует и страница, и фоновый сервис Android).</summary>
public static class AppServices
{
    public static LibraryStore Library { get; } = new();
    public static TtsClient Tts { get; } = new();
    public static PreloadManager Preload { get; } = new(Tts);

    static PlaybackEngine? engine;
    public static PlaybackEngine Engine => engine ??= new PlaybackEngine(CreateOutput(), Tts);

    public static IAudioOutput CreateOutput()
    {
#if ANDROID
        return new AndroidAudioOutput();
#elif WINDOWS
        return new WindowsAudioOutput();
#else
        return new NullAudioOutput();
#endif
    }
}

/// <summary>Заглушка для платформ без реализации звука.</summary>
public sealed class NullAudioOutput : IAudioOutput
{
    public event Action<int>? SegmentStarted;
    public event Action? Drained;
    public void Enqueue(string wavPath, int tag) { SegmentStarted?.Invoke(tag); Drained?.Invoke(); }
    public void Pause() { }
    public void Resume() { }
    public void Stop() { }
    public void SetRate(double rate) { }
}
