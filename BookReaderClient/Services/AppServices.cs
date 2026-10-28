namespace BookReaderClient.Services;

/// <summary>Общие сервисы приложения (одни на процесс: их использует и страница, и фоновый сервис Android).</summary>
public static class AppServices
{
    public static LibraryStore Library { get; } = new();
    public static TtsClient Tts { get; } = new();
    public static PreloadManager Preload { get; } = new(Tts);

    static PlaybackEngine? engine;
    public static PlaybackEngine Engine
    {
        get
        {
            if (engine != null) return engine;
            engine = new PlaybackEngine(CreateOutput(), Tts);
            // озвучка книги заиграла — аудиокниге пауза (звучит что-то одно)
            engine.StateChanged += (playing, loading) => { if (playing || loading) MediaStarted(TtsSource); };
            return engine;
        }
    }

    static TtsMedia? ttsSource;
    public static TtsMedia TtsSource => ttsSource ??= new TtsMedia(Engine);

    static AudiobookPlayer? audiobook;
    /// <summary>Плеер готовых аудиокниг (шаг 8).</summary>
    public static AudiobookPlayer Audiobook => audiobook ??= new AudiobookPlayer(CreateAbOutput());

    /// <summary>Чем управляют уведомление и гарнитура: тем, что запустили последним.</summary>
    public static IMediaSource Active { get; private set; } = new IdleMedia();
    public static event Action? ActiveChanged;

    public static void MediaStarted(IMediaSource source)
    {
        if (source is AudiobookPlayer) { if (engine != null && (engine.IsPlaying || engine.IsLoading)) engine.Pause(); }
        else if (audiobook != null && (audiobook.IsPlaying || audiobook.IsLoading)) audiobook.Pause();
        if (ReferenceEquals(Active, source)) return;
        Active = source;
        ActiveChanged?.Invoke();
    }

    public static IAbOutput? CreateAbOutput()
    {
#if ANDROID
        return new AndroidAbOutput();
#else
        return null;   // Windows и прочее: аудиокниги не поддерживаются (выпускается только APK)
#endif
    }

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

/// <summary>Пока ничего не запускали.</summary>
public sealed class IdleMedia : IMediaSource
{
    public bool IsPlaying => false;
    public bool IsLoading => false;
    public string Title => "BookReader";
    public string Subtitle => "";
    public void Play() { }
    public void Pause() { }
    public void Toggle() { }
    public void Next() { }
    public void Prev() { }
    public void Stop() { }
    public event Action? Changed { add { } remove { } }
}
