using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace BookReaderClient.Services;

/// <summary>
/// Звук одной части аудиокниги (кусок файла библиотеки: ZIP без сжатия хранит части подряд).
/// На Android — системный MediaPlayer (MP3, M4B/AAC, OGG/Opus, FLAC, WAV), см. Platforms/Android/AndroidAbOutput.cs.
/// </summary>
public interface IAbOutput
{
    /// <summary>Открыть кусок файла [offset, offset+length) и встать на позицию (мс). Готово — когда вернулась задача.</summary>
    Task LoadAsync(string path, long offset, long length, long positionMs);
    void Play(double rate);
    void Pause();
    void SeekMs(long ms);
    long PositionMs { get; }
    void SetRate(double rate);
    void Release();
    /// <summary>Часть доиграна до конца.</summary>
    event Action? Completed;
    event Action<string>? Failed;
}

/// <summary>
/// Плеер готовых аудиокниг (шаг 8). Команды — из веб-части (JsBridge.Ab*) и из уведомления/гарнитуры
/// (PlaybackService). Позиция — секунды от начала книги; сохраняется в библиотеку сама (раз в 10 с, на паузе),
/// поэтому место не теряется, даже если страница в фоне не работает.
/// </summary>
public sealed class AudiobookPlayer : IMediaSource
{
    sealed record Part(long Off, long Size, double Duration);
    sealed record Chapter(string Title, double At);

    readonly IAbOutput? output;
    readonly object sync = new();
    string bookId = "", title = "", author = "";
    List<Part> parts = [];
    List<Chapter> chapters = [];
    double[] starts = [];
    double duration;
    int part = -1;               // загруженная часть
    double at;                   // позиция, если ничего не загружено (или пока грузится)
    double rate = 1;
    bool playing, loading, ended;
    string? error;
    DateTime lastSave = DateTime.MinValue;
    System.Threading.Timer? ticker;
    // таймер сна: до какого времени (UTC) или до конца какой главы
    DateTime? sleepUntil;
    int sleepChapter = -1;
    int gen;                     // номер команды: устаревшие загрузки не применяются
    int shownChapter = -1;       // глава в уведомлении

    public AudiobookPlayer(IAbOutput? output)
    {
        this.output = output;
        if (output == null) return;
        output.Completed += () => MainThread.BeginInvokeOnMainThread(OnCompleted);
        output.Failed += msg => MainThread.BeginInvokeOnMainThread(() => Fail(msg));
    }

    public event Action? Changed;
    public string BookId => bookId;
    public bool HasBook => parts.Count > 0;
    public bool IsPlaying => playing;
    public bool IsLoading => loading;
    public string Title => title;
    public string Subtitle
    {
        get
        {
            var c = ChapterAt(Position);
            var ch = c >= 0 && chapters.Count > 1 ? chapters[c].Title : author;
            return ch;
        }
    }

    void Need()
    {
        if (output == null) throw new InvalidOperationException("аудиокниги в этой версии приложения не поддерживаются");
    }

    // ---------- книга ----------

    /// <summary>{ id, title, authors[], parts: [{ off, size, duration }], chapters: [{ title, at }], at }</summary>
    public void Open(string json)
    {
        Need();
        var o = JsonNode.Parse(json)?.AsObject() ?? throw new ArgumentException("нет книги");
        var id = o["id"]?.GetValue<string>() ?? "";
        if (id == bookId && parts.Count > 0) { Raise(); return; }   // та же книга (страницу перезагрузили) — играет дальше
        Stop();
        lock (sync)
        {
            bookId = id;
            title = o["title"]?.GetValue<string>() ?? "";
            author = string.Join(", ", (o["authors"] as JsonArray ?? new JsonArray()).Select(a => a?.GetValue<string>() ?? ""));
            parts = (o["parts"] as JsonArray ?? new JsonArray()).Select(p => new Part((long)Num(p?["off"]), (long)Num(p?["size"]), Num(p?["duration"]))).ToList();
            chapters = (o["chapters"] as JsonArray ?? new JsonArray()).Select(c => new Chapter(c?["title"]?.GetValue<string>() ?? "", Num(c?["at"])))
                .OrderBy(c => c.At).ToList();
            starts = new double[parts.Count];
            double t = 0;
            for (var i = 0; i < parts.Count; i++) { starts[i] = t; t += parts[i].Duration; }
            duration = t;
            at = Math.Clamp(Num(o["at"]), 0, Math.Max(0, duration));
            part = -1; ended = false; error = null;
            sleepUntil = null; sleepChapter = -1;
        }
        Raise();
    }

    public void Play(double atSec, double newRate)
    {
        Need();
        if (parts.Count == 0) return;
        rate = Math.Clamp(newRate, 0.5, 3);
        if (duration > 0 && atSec >= duration - 1) atSec = 0;
        AppServices.MediaStarted(this);           // озвучка книги — на паузу: звучит что-то одно
        _ = StartAsync(atSec);
    }

    async Task StartAsync(double atSec)
    {
        int my;
        lock (sync) { my = ++gen; playing = true; loading = true; ended = false; error = null; }
        Raise();
        try
        {
            await PlaceAsync(atSec, my);
            if (my != gen) return;
            output!.Play(rate);
            lock (sync) loading = false;
            StartTicker();
        }
        catch (Exception ex) { if (my == gen) Fail(ex.Message); }
        Raise();
    }

    // встать на позицию: загрузить нужную часть (если другая) и перемотать
    async Task PlaceAsync(double atSec, int my)
    {
        var p = PartOf(atSec);
        var local = Math.Max(0, atSec - starts[p]);
        if (p != part)
        {
            lock (sync) { at = atSec; part = -1; }
            await output!.LoadAsync(LibraryStore.BookFile(bookId), parts[p].Off, parts[p].Size, (long)(local * 1000));
            if (my != gen) return;
            lock (sync) part = p;
        }
        else output!.SeekMs((long)(local * 1000));
        lock (sync) at = atSec;
    }

    public void Pause()
    {
        if (output == null || parts.Count == 0) return;
        lock (sync) { gen++; at = Position; playing = false; loading = false; }
        output.Pause();
        StopTicker();
        Save(force: true);
        Raise();
    }

    public void Toggle()
    {
        if (playing || loading) Pause(); else if (parts.Count > 0) Play(Position, rate);
    }
    void IMediaSource.Play() { if (parts.Count > 0) Play(Position, rate); }
    public void Next() => Seek(Position + 30);
    public void Prev() => Seek(Position - 15);

    public void Seek(double atSec)
    {
        if (output == null || parts.Count == 0) return;
        atSec = Math.Clamp(atSec, 0, Math.Max(0, duration - 0.5));
        if (sleepChapter >= 0) sleepChapter = ChapterAt(atSec);
        if (playing) { _ = StartAsync(atSec); return; }
        // на паузе: часть та же — перематываем; другая — загрузим при ▶
        lock (sync)
        {
            gen++;
            if (PartOf(atSec) == part) output.SeekMs((long)((atSec - starts[part]) * 1000));
            else part = -1;
            at = atSec;
            ended = false;
        }
        Save(force: true);
        Raise();
    }

    public void SetRate(double r)
    {
        rate = Math.Clamp(r, 0.5, 3);
        if (playing) output?.SetRate(rate);
    }

    /// <summary>Таймер сна: minutes &gt; 0 — через столько минут; chapterEnd — в конце текущей главы; иначе выключить.</summary>
    public void SetSleep(int minutes, bool chapterEnd)
    {
        lock (sync)
        {
            sleepUntil = minutes > 0 ? DateTime.UtcNow.AddMinutes(minutes) : null;
            sleepChapter = chapterEnd ? ChapterAt(Position) : -1;
        }
        Raise();
    }

    public void Stop()
    {
        if (output == null) return;
        lock (sync) { gen++; if (part >= 0) at = Position; playing = false; loading = false; part = -1; }
        StopTicker();
        if (parts.Count > 0) Save(force: true);
        output.Release();
        Raise();
    }

    // ---------- состояние ----------

    public double Position
    {
        get
        {
            lock (sync)
            {
                if (part < 0 || output == null || loading) return at;
                return Math.Min(duration, starts[part] + output.PositionMs / 1000.0);
            }
        }
    }

    public string StateJson()
    {
        var sleepLeft = sleepChapter >= 0 ? -1 : sleepUntil is { } u ? Math.Max(0, (int)(u - DateTime.UtcNow).TotalSeconds) : 0;
        return JsonSerializer.Serialize(new
        {
            bookId, at = Position, playing, loading, ended, sleepLeft, error,
        });
    }

    int PartOf(double t)
    {
        var p = 0;
        for (var i = 0; i < starts.Length; i++) if (t >= starts[i] - 0.001) p = i;
        return p;
    }
    int ChapterAt(double t)
    {
        var c = chapters.Count > 0 ? 0 : -1;
        for (var i = 0; i < chapters.Count; i++) if (t >= chapters[i].At - 0.25) c = i;
        return c;
    }
    double ChapterEnd(int c) => c + 1 < chapters.Count ? chapters[c + 1].At : duration;

    // ---------- ход ----------

    void OnCompleted()
    {
        if (!playing) return;
        var next = part + 1;
        if (next < parts.Count) { _ = StartAsync(starts[next]); return; }
        lock (sync) { gen++; playing = false; loading = false; ended = true; at = duration; }
        StopTicker();
        Save(force: true);
        Raise();
    }

    void Fail(string msg)
    {
        lock (sync) { gen++; playing = false; loading = false; error = msg; part = -1; }
        StopTicker();
        Raise();
        lock (sync) error = null;   // ошибку показываем один раз
    }

    void StartTicker()
    {
        ticker ??= new System.Threading.Timer(_ => MainThread.BeginInvokeOnMainThread(Tick), null, 1000, 1000);
    }
    void StopTicker()
    {
        ticker?.Dispose();
        ticker = null;
    }

    void Tick()
    {
        if (!playing || loading) return;
        var pos = Position;
        if (sleepUntil is { } u && DateTime.UtcNow >= u) { SleepNow(); return; }
        if (sleepChapter >= 0 && pos >= ChapterEnd(sleepChapter) - 0.3) { SleepNow(); return; }
        Save(force: false);
        var c = ChapterAt(pos);
        if (c != shownChapter) { shownChapter = c; Changed?.Invoke(); }   // уведомление: сменилась глава
    }

    void SleepNow()
    {
        lock (sync) { sleepUntil = null; sleepChapter = -1; }
        Pause();
    }

    void Save(bool force)
    {
        if (string.IsNullOrEmpty(bookId) || parts.Count == 0) return;
        if (!force && DateTime.UtcNow - lastSave < TimeSpan.FromSeconds(10)) return;
        lastSave = DateTime.UtcNow;
        var pos = Position;
        var progress = duration > 0 ? Math.Min(1, pos / duration) : 0;
        try
        {
            AppServices.Library.Update(bookId, string.Create(CultureInfo.InvariantCulture,
                $"{{\"apos\":{pos:0.###},\"progress\":{progress:0.#####}}}"));
        }
        catch { }
    }

    void Raise() => Changed?.Invoke();

    static double Num(JsonNode? v)
    {
        if (v == null) return 0;
        try { return v.GetValue<double>(); } catch { }
        try { return v.GetValue<long>(); } catch { }
        return 0;
    }
}
