namespace BookReaderClient.Services;

/// <summary>
/// Очередь чтения вслух. Скачивает озвучку фраз заранее (Prefetch вперёд) и заранее же ставит
/// несколько готовых фраз в бесшовный вывод (Queued) — следующая звучит сразу после предыдущей.
/// Работает в C#, поэтому продолжает читать в фоне (на Android — вместе с PlaybackService).
/// </summary>
public sealed class PlaybackEngine
{
    public record Seg(string Text, double Pause);

    const int Prefetch = 5;   // сколько фраз вперёд держать скачанными
    const int Queued = 3;     // сколько фраз вперёд уже лежит в аудиопотоке

    readonly IAudioOutput output;
    readonly TtsClient tts;
    readonly object sync = new();
    readonly Dictionary<int, Task<string>> cache = new();

    List<Seg> queue = new();
    string bookId = "";
    string voice = "aidar";
    double rate = 1;
    int index = -1;          // фраза, которая звучит (или ждёт загрузки)
    int nextToEnqueue;       // следующая фраза для постановки в аудиопоток
    int gen;
    bool playing, loading, paused;
    // долгая пауза: после неё фраза читается с начала, а не с середины слова
    static readonly TimeSpan LongPause = TimeSpan.FromMinutes(15);
    DateTime pausedAt;
    bool restartOnResume;   // остановил таймер сна в начале новой главы — продолжить её с начала
    // таймер сна: пауза через N минут или в начале фразы sleepAt (начало следующей главы)
    System.Threading.Timer? sleepTimer;
    int sleepAt = -1;
    int schedulingGen = -1;  // поколение, для которого сейчас крутится ScheduleAsync
    bool scheduleAgain;
    // отмена загрузок фраз: новая книга / новая позиция / стоп — запросы к серверу для прежней отменяются
    CancellationTokenSource playCts = new();

    /// <summary>
    /// Новый токен для загрузок (вызывать под lock(sync)). Возвращает прежний источник — его отменяют
    /// уже ПОСЛЕ выхода из lock: продолжения отменённых задач не должны выполняться посреди смены состояния.
    /// </summary>
    CancellationTokenSource RenewToken()
    {
        var old = playCts;
        playCts = new CancellationTokenSource();
        return old;
    }

    /// <summary>Отменить прежние загрузки (без Dispose: токен ещё могут проверять завершающиеся запросы).</summary>
    static void CancelOld(CancellationTokenSource? old)
    {
        try { old?.Cancel(); } catch (AggregateException) { }
    }

    public string BookTitle { get; private set; } = "";
    public string BookId => bookId;
    public string Voice => voice;
    /// <summary>Фразы открытой книги (их же качает предзагрузка).</summary>
    public IReadOnlyList<Seg> Segments => queue;
    public int Index => index;
    public bool IsPlaying => playing;
    public bool IsLoading => loading;
    public bool HasBook => queue.Count > 0;
    public string CurrentText => index >= 0 && index < queue.Count ? queue[index].Text : "";

    public event Action<int>? SegmentChanged;
    public event Action<bool, bool>? StateChanged;   // playing, loading
    public event Action<string>? Error;
    public event Action? Ended;
    /// <summary>Сработал таймер сна (чтение поставлено на паузу).</summary>
    public event Action? SleepFired;

    public PlaybackEngine(IAudioOutput output, TtsClient tts)
    {
        this.output = output;
        this.tts = tts;
        output.SegmentStarted += OnSegmentStarted;
        output.Drained += OnDrained;
    }

    static string CacheDir
    {
        get { var d = Path.Combine(FileSystem.CacheDirectory, "tts"); Directory.CreateDirectory(d); return d; }
    }

    // ---------- команды ----------

    public void SetQueue(string id, string title, List<Seg> segs)
    {
        Stop();
        lock (sync)
        {
            bookId = id;
            BookTitle = title;
            queue = segs;
            index = -1;
            ClearCache();
        }
        // заранее (в фоне) посчитать ключи фраз и прочитать список скачанного — потом проверки мгновенные
        var (b, v) = (id, voice);
        _ = Task.Run(() => { AudioStore.KeysOf(segs); AudioStore.Has(b, v, ""); });
    }

    public void Play(int i)
    {
        if (queue.Count == 0) return;
        int my;
        CancellationTokenSource old;
        lock (sync)
        {
            my = ++gen;
            old = RenewToken();
            output.Stop();
            index = Math.Clamp(i, 0, queue.Count - 1);
            nextToEnqueue = index;
            playing = true;
            paused = false;
            restartOnResume = false;
            loading = true;
        }
        CancelOld(old);
        output.SetRate(rate);
        AppServices.Preload.Prioritize(bookId, voice, index); // если книга качается — сначала отсюда
        SegmentChanged?.Invoke(index);
        RaiseState();
        _ = ScheduleAsync(my);
    }

    /// <summary>▶: если стоим на паузе на этой же фразе — продолжаем, иначе читаем фразу i с начала.</summary>
    public void Resume(int i)
    {
        // та же фраза и пауза была недолгой — продолжаем с того же места; иначе фразу читаем с начала
        if (paused && i == index && !restartOnResume && DateTime.UtcNow - pausedAt < LongPause)
        {
            paused = false;
            playing = true;
            output.Resume();
            RaiseState();
            _ = ScheduleAsync(gen);
        }
        else Play(i < 0 ? Math.Max(index, 0) : i);
    }

    public void Pause()
    {
        if (!playing && !loading) return;
        playing = false;
        loading = false;
        paused = true;
        pausedAt = DateTime.UtcNow;
        output.Pause();
        RaiseState();
    }

    /// <summary>Таймер сна: minutes &gt; 0 — пауза через столько минут; atIndex &gt;= 0 — пауза в начале этой фразы
    /// (начало следующей главы). Оба 0/-1 — таймер выключен.</summary>
    public void SetSleep(int minutes, int atIndex)
    {
        lock (sync)
        {
            sleepTimer?.Dispose();
            sleepTimer = null;
            sleepAt = atIndex;
            if (minutes > 0)
                sleepTimer = new System.Threading.Timer(_ => MainThread.BeginInvokeOnMainThread(SleepNow), null,
                    TimeSpan.FromMinutes(minutes), System.Threading.Timeout.InfiniteTimeSpan);
        }
    }

    void SleepNow()
    {
        lock (sync)
        {
            sleepTimer?.Dispose();
            sleepTimer = null;
            sleepAt = -1;
        }
        Pause();
        SleepFired?.Invoke();
    }

    public void Stop()
    {
        CancellationTokenSource old;
        lock (sync)
        {
            gen++;
            old = RenewToken();
            playing = false;
            loading = false;
            paused = false;
            output.Stop();
        }
        CancelOld(old);
        RaiseState();
    }

    public void TogglePlayPause()
    {
        if (playing || loading) Pause(); else Resume(index);
    }

    public void Next() { if (queue.Count > 0) Play(index + 1); }
    public void Prev() { if (queue.Count > 0) Play(index - 1); }

    public void SetRate(double r)
    {
        rate = Math.Clamp(r, 0.5, 3);
        output.SetRate(rate);
    }

    public void SetVoice(string v)
    {
        if (string.IsNullOrWhiteSpace(v) || v == voice) return;
        CancellationTokenSource old;
        lock (sync) { voice = v; old = RenewToken(); ClearCache(); }
        CancelOld(old);
        if (playing) Play(index);
    }

    /// <summary>Изменились личные правила произношения: полученную озвучку берём заново.</summary>
    public void PronChanged()
    {
        CancellationTokenSource old;
        lock (sync) { old = RenewToken(); ClearCache(); }
        CancelOld(old);
        if (playing) Play(index);
    }

    public void Configure(string? v, string? r)
    {
        if (!string.IsNullOrWhiteSpace(v) && v != voice)
        {
            CancellationTokenSource old;
            lock (sync) { voice = v; old = RenewToken(); ClearCache(); }
            CancelOld(old);
        }
        if (double.TryParse(r, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d)) rate = Math.Clamp(d, 0.5, 3);
    }

    // ---------- очередь ----------

    /// <summary>Поставить в аудиопоток готовые фразы до index+Queued и скачивать вперёд до index+Prefetch.</summary>
    async Task ScheduleAsync(int my)
    {
        lock (sync)
        {
            if (my != gen) return;
            if (schedulingGen == my) { scheduleAgain = true; return; }
            schedulingGen = my;
            scheduleAgain = false;
        }
        try
        {
            while (true)
            {
                int j;
                lock (sync)
                {
                    if (my != gen || !playing) return;
                    j = nextToEnqueue;
                    if (j >= queue.Count || j > index + Queued)
                    {
                        if (scheduleAgain) { scheduleAgain = false; continue; }
                        break;
                    }
                }
                string path;
                try
                {
                    path = await GetAudioAsync(j);
                }
                catch (Exception ex)
                {
                    if (my != gen) return;
                    lock (sync) { playing = false; loading = false; }
                    output.Stop();
                    RaiseState();
                    Error?.Invoke(ex is OfflineModeException
                        ? "это место книги не скачано, а включён режим «Без сервера». Скачайте озвучку (Оглавление → «Озвучка без интернета») или включите сервер в настройках"
                        : TtsClient.Friendly(ex));
                    return;
                }
                lock (sync)
                {
                    if (my != gen || !playing) return;
                    if (nextToEnqueue != j) continue;
                    try { output.Enqueue(path, j); }
                    catch { TryDelete(path); cache.Remove(j); continue; } // битый файл — удалим и получим заново
                    nextToEnqueue = j + 1;
                }
            }
        }
        finally
        {
            lock (sync) if (schedulingGen == my) schedulingGen = -1;
        }
        _ = PrefetchAsync(my);
    }

    async Task PrefetchAsync(int my)
    {
        for (var k = 0; k <= Prefetch; k++)
        {
            int j;
            lock (sync)
            {
                if (my != gen) return;
                j = index + k;
                if (j < 0 || j >= queue.Count) break;
            }
            try { await GetAudioAsync(j); } catch { break; }
        }
        CleanupCache(index);
    }

    void OnSegmentStarted(int tag)
    {
        bool sleepHere;
        lock (sync)
        {
            if (!playing || tag < 0 || tag >= queue.Count) return;
            index = tag;
            loading = false;
            sleepHere = sleepAt >= 0 && tag >= sleepAt;
        }
        if (sleepHere)
        {
            // глава закончилась — пауза; при продолжении новая глава начнётся с начала фразы
            SegmentChanged?.Invoke(tag);
            MainThread.BeginInvokeOnMainThread(() => { SleepNow(); restartOnResume = true; });
            return;
        }
        SegmentChanged?.Invoke(tag);
        RaiseState();
        _ = ScheduleAsync(gen);
    }

    void OnDrained()
    {
        bool ended;
        lock (sync)
        {
            if (!playing) return;
            ended = nextToEnqueue >= queue.Count;
            if (ended) playing = false;
            else loading = true; // следующая фраза ещё не скачана — ждём её
        }
        RaiseState();
        if (ended) Ended?.Invoke();
        else _ = ScheduleAsync(gen);
    }

    // ---------- скачивание ----------

    Task<string> GetAudioAsync(int i)
    {
        lock (sync)
        {
            if (cache.TryGetValue(i, out var t) && !t.IsFaulted && !t.IsCanceled) return t;
            // скачанная заранее озвучка — без сервера
            var local = AudioStore.FindSeg(bookId, voice, queue[i].Text, queue[i].Pause, AudioStore.KeysOf(queue)[i]);
            t = local != null ? Task.FromResult(local) : DownloadAsync(i, voice, bookId, queue[i], playCts.Token);
            cache[i] = t;
            return t;
        }
    }

    async Task<string> DownloadAsync(int i, string v, string book, Seg seg, CancellationToken ct)
    {
        var path = Path.Combine(CacheDir, $"{book}_{i}_{v}.audio");
        if (File.Exists(path)) return path;

        // эта фраза как раз скачивается для офлайна — ждём её оттуда, а не генерируем второй раз
        var key = AudioStore.Key(seg.Text, seg.Pause);
        var preload = AppServices.Preload;
        preload.Prioritize(book, v, i);
        var wait = preload.WaitFor(book, v, key);
        if (wait != null)
        {
            var first = await Task.WhenAny(wait, Task.Delay(TimeSpan.FromSeconds(20), ct));
            if (first == wait && await wait && AudioStore.Find(book, v, key) is { } ready) return ready;
        }
        ct.ThrowIfCancellationRequested();
        Exception? last = null;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                var bytes = await tts.SynthAsync(seg.Text, v, seg.Pause, ct, bookId: book);
                ct.ThrowIfCancellationRequested();      // ответ опоздал — книга уже другая, файл не пишем
                var tmp = path + ".part";
                await File.WriteAllBytesAsync(tmp, bytes, CancellationToken.None);
                File.Move(tmp, path, true);
                return path;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;                                  // отменено нами — не ошибка сети, не повторяем
            }
            catch (ServerException busy) when (busy.IsBusy && attempt < 2)
            {
                last = busy; // сервер перегружен слушателями — короткая пауза и ещё раз
                await Task.Delay(TimeSpan.FromSeconds(Math.Min(5, busy.RetryAfter.TotalSeconds)), ct);
            }
            catch (Exception ex) when (ex is not InvalidOperationException)
            {
                last = ex;
                await Task.Delay(700 * (attempt + 1), ct);
            }
        }
        throw last ?? new Exception("не удалось получить озвучку");
    }

    void CleanupCache(int around)
    {
        lock (sync)
        {
            foreach (var key in cache.Keys.Where(k => k < around - 2 || k > around + Prefetch + 6).ToList())
            {
                var t = cache[key];
                cache.Remove(key);
                if (t.IsCompletedSuccessfully) TryDeleteTemp(t.Result);
            }
        }
    }

    void ClearCache()
    {
        cache.Clear();
        // удаление временных файлов — в фоне: на открытии книги это не должно задерживать интерфейс.
        // Удаляем только файлы старше этого момента — новые фразы новой книги могут уже скачиваться.
        var before = DateTime.UtcNow;
        _ = Task.Run(() =>
        {
            try
            {
                foreach (var f in Directory.GetFiles(CacheDir))
                    try { if (File.GetLastWriteTimeUtc(f) <= before) File.Delete(f); } catch { }
            }
            catch { }
        });
    }

    void RaiseState() => StateChanged?.Invoke(playing, loading);

    static void TryDelete(string p) { try { File.Delete(p); } catch { } }

    /// <summary>Удаляем только временные файлы потокового чтения, скачанную озвучку не трогаем.</summary>
    static void TryDeleteTemp(string p) { if (p.StartsWith(CacheDir, StringComparison.Ordinal)) TryDelete(p); }
}
