namespace BookReaderClient.Services;

/// <summary>
/// Что сейчас звучит: озвучка книги (PlaybackEngine) или аудиокнига (AudiobookPlayer).
/// Уведомление и кнопки гарнитуры (PlaybackService) управляют тем, что запущено последним.
/// </summary>
public interface IMediaSource
{
    bool IsPlaying { get; }
    bool IsLoading { get; }
    string Title { get; }
    string Subtitle { get; }
    void Play();
    void Pause();
    void Toggle();
    /// <summary>Озвучка — следующая фраза; аудиокнига — вперёд на 30 с.</summary>
    void Next();
    /// <summary>Озвучка — предыдущая фраза; аудиокнига — назад на 15 с.</summary>
    void Prev();
    void Stop();
    event Action? Changed;
}

/// <summary>Озвучка книги как источник для уведомления.</summary>
public sealed class TtsMedia : IMediaSource
{
    readonly PlaybackEngine e;
    public TtsMedia(PlaybackEngine engine)
    {
        e = engine;
        e.StateChanged += (_, _) => Changed?.Invoke();
        e.SegmentChanged += _ => Changed?.Invoke();
        e.Ended += () => Changed?.Invoke();
    }
    public bool IsPlaying => e.IsPlaying;
    public bool IsLoading => e.IsLoading;
    public string Title => e.BookTitle;
    public string Subtitle => e.CurrentText;
    public void Play() => e.Resume(e.Index);
    public void Pause() => e.Pause();
    public void Toggle() => e.TogglePlayPause();
    public void Next() => e.Next();
    public void Prev() => e.Prev();
    public void Stop() => e.Stop();
    public event Action? Changed;
}
