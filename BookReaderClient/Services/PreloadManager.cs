using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace BookReaderClient.Services;

/// <summary>
/// Загрузка озвучки для чтения без сервера.
/// <list type="bullet">
/// <item>Одна очередь книг: озвучивается строго одна книга за раз, остальные ждут (сервер и память не перегружаются).</item>
/// <item>Уже загруженные фразы не качаются повторно — ни при повторной загрузке, ни при дозагрузке «главы → вся книга».</item>
/// <item>Обрыв связи: загрузка встаёт на паузу, сервер проверяется раз в 3–15 с; после восстановления
///       ждём 30 с решения пользователя, без ответа — продолжаем сами.</item>
/// <item>Статус в интерфейс — не чаще ~1 раза в секунду на книгу (кроме смены состояния).</item>
/// </list>
/// </summary>
public sealed class PreloadManager
{
    /// <summary>Задание: фразы либо в памяти (открытая книга), либо в файле (групповая загрузка — память не занимаем).
    /// Refresh — уже скачанные фразы, которые надо скачать заново (кнопка «Обновить»: устарели или скачаны до 1.2.0);
    /// старый файл заменяется только когда пришёл новый. RefreshOnly — только эти фразы, недостающие не докачивать.</summary>
    public sealed record Job(string BookId, string Title, string Voice, IReadOnlyList<PlaybackEngine.Seg>? Segs, int From, int To,
        string? SegsFile = null, IReadOnlySet<string>? Refresh = null, bool RefreshOnly = false);

    sealed class Live
    {
        public required Job Job;
        public required IReadOnlyList<PlaybackEngine.Seg> Segs;
        public int Total, Done, JobTotal, JobDone;
        public long Bytes;
        // очередь фраз этого задания: (позиция в книге, ключ). Порядок меняется, когда пользователь начинает слушать —
        // тогда первыми качаются фразы от места чтения, и плеер берёт их отсюда, а не генерирует второй раз.
        public readonly List<(int Pos, string Key)> Pending = new();
        public readonly HashSet<string> PendingKeys = new();
        public readonly HashSet<string> InFlight = new();
        public readonly Dictionary<string, TaskCompletionSource<bool>> Waiters = new();
        public readonly Dictionary<string, (string Text, double Pause)> All = new();
        public CancellationTokenSource Cts = new();
        public long FpSavedAt = Environment.TickCount64;
    }

    public enum NetState { Ok, NoConnection, Reconnected, Held }

    const int Workers = 2;                                   // 2 пакета одной книги: пока один считается, другой едет по сети
    static readonly TimeSpan ResumeDelay = TimeSpan.FromSeconds(30);
    static readonly TimeSpan NotifyEvery = TimeSpan.FromMilliseconds(900);

    readonly TtsClient tts;
    readonly object sync = new();
    readonly List<Job> queue = new();
    Live? live;
    bool runnerActive;                                      // крутится цикл RunAsync (одна книга за раз)
    readonly Dictionary<string, string> errors = new();     // "книга|голос" → последняя ошибка

    // связь
    NetState net = NetState.Ok;
    DateTimeOffset resumeAt;
    TaskCompletionSource<bool>? resumeTcs;
    Task? netWait;

    /// <summary>Изменилось состояние (JSON { bookId, rows: [...], queue: {...} }).</summary>
    public event Action<string>? Changed;

    /// <summary>Загрузка началась / всё закончилось (на Android — фоновая служба).</summary>
    public event Action<bool>? ActiveChanged;

    public PreloadManager(TtsClient tts) => this.tts = tts;

    public bool IsActive { get { lock (sync) return live != null || queue.Count > 0; } }

    /// <summary>Текст для уведомления.</summary>
    public string Summary
    {
        get
        {
            lock (sync)
            {
                if (live == null) return "";
                var pct = live.Total == 0 ? 0 : live.Done * 100 / live.Total;
                var head = net switch
                {
                    NetState.NoConnection => "Нет связи с сервером — загрузка на паузе. ",
                    NetState.Reconnected or NetState.Held => "Связь восстановлена — откройте приложение. ",
                    _ => "",
                };
                return head + $"{live.Job.Title} — {pct}%" + (queue.Count > 0 ? $" (в очереди: {queue.Count})" : "");
            }
        }
    }

    public int Percent { get { lock (sync) return live == null || live.JobTotal == 0 ? 0 : live.JobDone * 100 / live.JobTotal; } }

    // ---------- команды ----------

    public void Start(Job job)
    {
        bool run;
        lock (sync)
        {
            errors.Remove(job.BookId + "|" + job.Voice);
            if (live != null && live.Job.BookId == job.BookId && live.Job.Voice == job.Voice)
            {
                // эта книга этим голосом уже качается — просто добавляем недостающий диапазон, ничего не прерывая
                Extend(live, job);
                run = false;
            }
            else
            {
                var same = queue.FindIndex(j => j.BookId == job.BookId && j.Voice == job.Voice);
                if (same >= 0)
                {
                    // уже в очереди — объединяем диапазоны
                    var old = queue[same];
                    // обычная загрузка + «только обновить» = обычная загрузка (с обновлением)
                    queue[same] = old.RefreshOnly && !job.RefreshOnly ? job with { Refresh = Union(old.Refresh, job.Refresh) }
                        : !old.RefreshOnly && job.RefreshOnly ? old with { Refresh = Union(old.Refresh, job.Refresh) }
                        : job with { From = Math.Min(old.From, job.From), To = Math.Max(old.To, job.To), Refresh = Union(old.Refresh, job.Refresh) };
                }
                else queue.Add(job);
                run = !runnerActive;
                if (run) runnerActive = true;
            }
        }
        Notify(job.BookId, force: true);
        if (run) _ = Task.Run(RunAsync); // подсчёт уже загруженного и сеть — не в потоке интерфейса
    }

    static IReadOnlySet<string>? Union(IReadOnlySet<string>? a, IReadOnlySet<string>? b) =>
        a == null ? b : b == null ? a : a.Concat(b).ToHashSet(StringComparer.Ordinal);

    /// <summary>Групповая загрузка: фразы книги пишем в файл, в очереди держим только ссылку.</summary>
    public void Enqueue(string bookId, string title, string voice, List<PlaybackEngine.Seg> segs)
    {
        var dir = Path.Combine(FileSystem.CacheDirectory, "dlqueue");
        Directory.CreateDirectory(dir);
        var file = Path.Combine(dir, $"{bookId}_{voice}.json");
        File.WriteAllText(file, JsonSerializer.Serialize(segs.Select(s => new object[] { s.Text, s.Pause })));
        Start(new Job(bookId, title, voice, null, 0, segs.Count, file));
    }

    static IReadOnlyList<PlaybackEngine.Seg> LoadSegs(Job job)
    {
        if (job.Segs != null) return job.Segs;
        if (job.SegsFile == null || !File.Exists(job.SegsFile)) return [];
        using var doc = JsonDocument.Parse(File.ReadAllText(job.SegsFile));
        return doc.RootElement.EnumerateArray()
            .Select(a => new PlaybackEngine.Seg(a[0].GetString() ?? "", a[1].GetDouble())).ToList();
    }

    void Extend(Live cur, Job job)
    {
        var keys = AudioStore.KeysOf(cur.Segs);
        var to = Math.Min(job.To, cur.Segs.Count);
        var added = 0;
        for (var i = Math.Max(0, job.From); i < to; i++)
        {
            var k = keys[i];
            if (job.RefreshOnly && !(job.Refresh?.Contains(k) ?? false)) continue;   // «Обновить» недостающее не докачивает
            if (cur.PendingKeys.Contains(k) || cur.InFlight.Contains(k)) continue;
            if (AudioStore.ExistingAt(cur.Job.BookId, cur.Job.Voice, cur.Segs, i) != null && !(job.Refresh?.Contains(k) ?? false)) continue;
            cur.All.TryAdd(k, (cur.Segs[i].Text, cur.Segs[i].Pause));
            cur.Pending.Add((i, k));
            cur.PendingKeys.Add(k);
            added++;
        }
        cur.JobTotal += added;
    }

    public void Cancel(string bookId)
    {
        lock (sync)
        {
            foreach (var j in queue.Where(j => j.BookId == bookId).ToList()) { queue.Remove(j); DropFile(j); }
            if (live != null && live.Job.BookId == bookId) live.Cts.Cancel();
        }
        Notify(bookId, force: true);
    }

    public void Delete(string bookId, string? voice)
    {
        Cancel(bookId);
        lock (sync)
        {
            foreach (var k in errors.Keys.Where(k => k.StartsWith(bookId + "|")).ToList()) errors.Remove(k);
        }
        if (string.IsNullOrEmpty(voice)) AudioStore.DeleteBook(bookId);
        else AudioStore.DeletePack(bookId, voice);
        Notify(bookId, force: true);
    }

    /// <summary>Очистить всю очередь и остановить текущую загрузку. Уже загруженное остаётся.</summary>
    public void CancelAll()
    {
        List<string> books;
        lock (sync)
        {
            books = queue.Select(j => j.BookId).ToList();
            foreach (var j in queue) DropFile(j);
            queue.Clear();
            if (live != null) { books.Add(live.Job.BookId); live.Cts.Cancel(); }
            net = NetState.Ok;
            resumeTcs?.TrySetResult(false);
        }
        foreach (var b in books.Distinct()) Notify(b, force: true);
    }

    public void DeleteAll()
    {
        CancelAll();
        lock (sync) errors.Clear();
        AudioStore.DeleteAll();
    }

    /// <summary>«Продолжить» после восстановления связи.</summary>
    public void ResumeNow()
    {
        lock (sync) resumeTcs?.TrySetResult(true);
    }

    /// <summary>Пользователь думает (открыл «Отменить загрузку?») — автопродолжение по таймеру отключаем.</summary>
    public void Hold()
    {
        lock (sync) if (net == NetState.Reconnected) net = NetState.Held;
        Notify(null, force: true);
    }

    static void DropFile(Job j)
    {
        if (j.SegsFile != null) try { File.Delete(j.SegsFile); } catch { }
    }

    // ---------- статус ----------

    /// <summary>Статус книг: [{ bookId, voice, total, done, bytes, running, queued, paused, jobDone, jobTotal, error }].</summary>
    public string StatusJson(string? onlyBook = null)
    {
        var rows = new Dictionary<string, Dictionary<string, object?>>();
        foreach (var (bookId, info) in AudioStore.AllPacks())
        {
            if (onlyBook != null && bookId != onlyBook) continue;
            rows[bookId + "|" + info.Voice] = Row(bookId, info.Voice, info.Total, info.Done, info.Bytes);
        }
        lock (sync)
        {
            foreach (var j in queue)
            {
                if (onlyBook != null && j.BookId != onlyBook) continue;
                var key = j.BookId + "|" + j.Voice;
                if (!rows.TryGetValue(key, out var r)) rows[key] = r = Row(j.BookId, j.Voice, 0, 0, 0);
                r["queued"] = true;
            }
            if (live != null && (onlyBook == null || live.Job.BookId == onlyBook))
            {
                var key = live.Job.BookId + "|" + live.Job.Voice;
                // задание ещё считает, что уже скачано (большая книга — секунды): показываем прежние цифры, а не 0%
                var preparing = live.Total == 0 && rows.ContainsKey(key);
                var r = preparing ? rows[key] : Row(live.Job.BookId, live.Job.Voice, live.Total, live.Done, live.Bytes);
                r["running"] = true;
                r["paused"] = net != NetState.Ok;
                r["jobDone"] = live.JobDone;
                r["jobTotal"] = live.JobTotal;
                rows[key] = r;
            }
            foreach (var (key, pct) in checkPct)   // идёт сверка: «проверяю … N%»
            {
                if (onlyBook != null && !key.StartsWith(onlyBook + "|")) continue;
                if (rows.TryGetValue(key, out var r)) r["checking"] = pct;
            }
            foreach (var (key, err) in errors)
            {
                if (onlyBook != null && !key.StartsWith(onlyBook + "|")) continue;
                if (!rows.TryGetValue(key, out var r))
                {
                    var p = key.Split('|');
                    rows[key] = r = Row(p[0], p[1], 0, 0, 0);
                }
                r["error"] = err;
            }
        }
        return JsonSerializer.Serialize(rows.Values);
    }

    /// <summary>Очередь целиком: { state, resumeAt, current: {...}|null, waiting: [...] }.</summary>
    public string QueueJson()
    {
        lock (sync)
        {
            var state = live == null && queue.Count == 0 ? "idle" : net switch
            {
                NetState.NoConnection => "nonet",
                NetState.Reconnected => "reconnected",
                NetState.Held => "held",
                _ => "running",
            };
            object? current = live == null ? null : new
            {
                bookId = live.Job.BookId, title = live.Job.Title, voice = live.Job.Voice,
                done = live.Done, total = live.Total, jobDone = live.JobDone, jobTotal = live.JobTotal,
            };
            return JsonSerializer.Serialize(new
            {
                state,
                resumeAt = net == NetState.Reconnected ? resumeAt.ToUnixTimeMilliseconds() : 0,
                current,
                waiting = queue.Select(j => new { bookId = j.BookId, title = j.Title, voice = j.Voice }),
            });
        }
    }

    static Dictionary<string, object?> Row(string bookId, string voice, int total, int done, long bytes)
    {
        // ждут обновления: stale — устарели (сверка), unknown — скачаны до 1.2.0 (без отпечатка)
        var (stale, unknown) = done > 0 ? AudioStore.Outdated(bookId, voice) : (0, 0);
        return new()
        {
            ["bookId"] = bookId, ["voice"] = voice, ["total"] = total, ["done"] = done, ["bytes"] = bytes,
            ["running"] = false, ["queued"] = false, ["paused"] = false, ["jobDone"] = 0, ["jobTotal"] = 0, ["error"] = null,
            ["stale"] = stale, ["unknown"] = unknown, ["checking"] = null,
        };
    }

    // уведомления в интерфейс: не чаще раза в NotifyEvery на книгу (прогресс), смена состояния — сразу
    readonly Dictionary<string, long> lastNotify = new();
    readonly HashSet<string> notifyPending = new();

    void Notify(string? bookId, bool force = false)
    {
        var key = bookId ?? "";
        if (!force)
        {
            lock (sync)
            {
                var now = Environment.TickCount64;
                if (lastNotify.TryGetValue(key, out var last) && now - last < NotifyEvery.TotalMilliseconds)
                {
                    if (notifyPending.Add(key))
                        _ = Task.Delay(NotifyEvery).ContinueWith(_ => { lock (sync) notifyPending.Remove(key); Notify(bookId, true); });
                    return;
                }
            }
        }
        lock (sync) lastNotify[key] = Environment.TickCount64;
        try
        {
            var rows = string.IsNullOrEmpty(bookId) ? "[]" : StatusJson(bookId);
            Changed?.Invoke($"{{\"bookId\":{JsonSerializer.Serialize(bookId ?? "")},\"rows\":{rows},\"queue\":{QueueJson()}}}");
        }
        catch { }
    }

    // ---------- работа ----------

    async Task RunAsync()
    {
        ActiveChanged?.Invoke(true);
        try
        {
            while (true)
            {
                Live cur;
                lock (sync)
                {
                    if (queue.Count == 0) { live = null; runnerActive = false; break; }
                    var job = queue[0];
                    queue.RemoveAt(0);
                    IReadOnlyList<PlaybackEngine.Seg> segs;
                    try { segs = LoadSegs(job); } catch { segs = []; }
                    live = cur = new Live { Job = job, Segs = segs };
                }
                try
                {
                    await RunJobAsync(cur);
                }
                catch (Exception) when (cur.Cts.IsCancellationRequested)
                {
                    // остановлено пользователем (или озвучку удалили во время загрузки)
                }
                catch (Exception ex)
                {
                    lock (sync) errors[cur.Job.BookId + "|" + cur.Job.Voice] = "загрузка остановлена: " + TtsClient.Friendly(ex) +
                        ". Уже загруженное сохранено — нажмите «Скачать», чтобы продолжить";
                }
                finally
                {
                    SavePack(cur, final: true);
                    DropFile(cur.Job);
                    lock (sync)
                    {
                        // задание закончилось (или остановлено) — ждущие фразы плеер получит у сервера сам
                        foreach (var w in cur.Waiters.Values) w.TrySetResult(false);
                        cur.Waiters.Clear();
                        live = null;
                    }
                    Notify(cur.Job.BookId, force: true);
                }
            }
        }
        finally
        {
            bool idle;
            lock (sync)
            {
                if (live == null && queue.Count == 0) runnerActive = false;
                idle = !runnerActive;
            }
            if (idle)
            {
                lock (sync) net = NetState.Ok;
                Notify(null, force: true);
                ActiveChanged?.Invoke(false);
            }
        }
    }

    async Task RunJobAsync(Live cur)
    {
        var job = cur.Job;
        var ct = cur.Cts.Token;
        var segs = cur.Segs;
        if (segs.Count == 0) throw new InvalidOperationException("не удалось прочитать фразы книги");
        Directory.CreateDirectory(AudioStore.PackDir(job.BookId, job.Voice));

        // уникальные фразы всей книги (повторы вроде «* * *» качаем один раз); уже загруженные — пропускаем
        var keys = AudioStore.KeysOf(segs);
        var ranged = new List<(int Pos, string Key)>();
        var to = Math.Min(job.To, segs.Count);
        for (var i = 0; i < segs.Count; i++)
        {
            cur.All.TryAdd(keys[i], (segs[i].Text, segs[i].Pause));
            if (i >= job.From && i < to) ranged.Add((i, keys[i]));
        }
        // скачанное пропускаем — кроме фраз, которые пользователь велел обновить
        // (фраза с тем же текстом, но другой паузой — тоже скачана: см. AudioStore.ExistingAt); отмена — сразу
        var have = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < segs.Count; i++)
        {
            if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();
            if (!(job.Refresh?.Contains(keys[i]) ?? false) && AudioStore.ExistingAt(job.BookId, job.Voice, segs, i, ct) != null) have.Add(keys[i]);
        }
        var seen = new HashSet<string>();
        var todo = ranged.Where(r => !have.Contains(r.Key) && (!job.RefreshOnly || job.Refresh!.Contains(r.Key)) && seen.Add(r.Key)).ToList();

        lock (sync)
        {
            cur.Total = cur.All.Count;
            cur.Done = have.Count;
            cur.JobTotal = todo.Count;
            cur.JobDone = 0;
            cur.Pending.AddRange(todo);
            foreach (var t in todo) cur.PendingKeys.Add(t.Key);
            if (priorityPos.TryGetValue(job.BookId + "|" + job.Voice, out var pp)) Reorder(cur, pp);
            cur.Bytes = AudioStore.DirSize(AudioStore.PackDir(job.BookId, job.Voice));
        }
        SavePack(cur);
        Notify(job.BookId, force: true);

        var workers = Enumerable.Range(0, Workers).Select(async _ =>
        {
            while (true)
            {
                string[] batch;
                lock (sync)
                {
                    if (cur.Pending.Count == 0) return;
                    // кто-то ждёт фразу для чтения прямо сейчас — маленький пакет, чтобы она пришла быстро
                    var size = cur.Waiters.Count > 0 ? 3 : TtsClient.BatchSize;
                    var n = Math.Min(size, cur.Pending.Count);
                    batch = cur.Pending.Take(n).Select(p => p.Key).ToArray();
                    cur.Pending.RemoveRange(0, n);
                    foreach (var k in batch) { cur.PendingKeys.Remove(k); cur.InFlight.Add(k); }
                }
                var saved = new HashSet<string>();
                try { await DownloadBatchAsync(cur, batch, ct, saved); }
                finally
                {
                    lock (sync)
                        foreach (var k in batch)
                        {
                            cur.InFlight.Remove(k);
                            if (cur.Waiters.Remove(k, out var w)) w.TrySetResult(saved.Contains(k));
                        }
                }
            }
        });
        await Task.WhenAll(workers);
    }

    // ---------- обрыв связи ----------

    /// <summary>Ошибка сети (а не данных): ждём связь, а не останавливаем загрузку.</summary>
    static bool IsNetworkError(Exception ex) => ex switch
    {
        HttpRequestException { StatusCode: null } => true,
        TaskCanceledException or TimeoutException or SocketException or IOException => true,
        ServerException { Code: HttpStatusCode.BadGateway or HttpStatusCode.ServiceUnavailable or HttpStatusCode.GatewayTimeout } => true,
        _ => ex.InnerException != null && IsNetworkError(ex.InnerException),
    };

    /// <summary>Пауза до восстановления связи (обе параллельные выгрузки ждут одно и то же ожидание).</summary>
    Task WaitForNetworkAsync(CancellationToken ct)
    {
        lock (sync) return netWait ??= NetLoopAsync(ct);
    }

    async Task NetLoopAsync(CancellationToken ct)
    {
        try
        {
            lock (sync) net = NetState.NoConnection;
            Notify(null, force: true);
            // проверяем сервер редко: 3 с, затем реже, до 15 с — сервер и батарею не дёргаем
            var delay = TimeSpan.FromSeconds(3);
            while (true)
            {
                await Task.Delay(delay, ct);
                try
                {
                    await tts.PingAsync(AppSettings.BaseUrl, ct);
                    break;
                }
                catch (Exception) when (!ct.IsCancellationRequested) { }
                delay = TimeSpan.FromSeconds(Math.Min(15, delay.TotalSeconds * 1.5));
            }
            // связь есть: 30 с на решение пользователя, без ответа — продолжаем
            TaskCompletionSource<bool> tcs;
            lock (sync)
            {
                tcs = resumeTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                resumeAt = DateTimeOffset.UtcNow + ResumeDelay;
                net = NetState.Reconnected;
            }
            Notify(null, force: true);
            while (!tcs.Task.IsCompleted)
            {
                await Task.WhenAny(tcs.Task, Task.Delay(500, ct));
                ct.ThrowIfCancellationRequested();
                lock (sync) if (net == NetState.Reconnected && DateTimeOffset.UtcNow >= resumeAt) break;
            }
            if (tcs.Task.IsCompleted && !tcs.Task.Result) throw new OperationCanceledException(); // «Отменить загрузку»
        }
        finally
        {
            lock (sync)
            {
                net = NetState.Ok;
                resumeTcs = null;
                netWait = null;
            }
            Notify(null, force: true);
        }
    }

    async Task DownloadBatchAsync(Live cur, string[] keys, CancellationToken ct, HashSet<string> saved)
    {
        var job = cur.Job;
        var items = keys.Select(k => cur.All[k]).ToList();
        TtsClient.BatchResult? result = null;
        for (var attempt = 0; ; attempt++)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                bool live;
                lock (sync) live = keys.Any(cur.Waiters.ContainsKey); // эти фразы ждёт чтение — сервер даст их вне очереди
                result = await tts.SynthBatchAsync(items, job.Voice, ct, live, job.BookId);
                break;
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                // сервер занят другими устройствами — это не обрыв связи и не ошибка: ждём и повторяем
                if (ex is ServerException { IsBusy: true } busy)
                {
                    await Task.Delay(busy.RetryAfter, ct);
                    attempt = -1;
                    continue;
                }
                if (IsNetworkError(ex))
                {
                    if (attempt < 2) { await Task.Delay(TimeSpan.FromSeconds(2), ct); continue; } // короткий сбой Wi-Fi
                    await WaitForNetworkAsync(ct);   // долгий обрыв — пауза до восстановления связи
                    attempt = -1;
                    continue;
                }
                // сервер не смог озвучить (500) — пару раз повторим; остальное (режим «Без сервера», старый сервер) — стоп
                if (ex is ServerException { Code: HttpStatusCode.InternalServerError } && attempt < 2)
                {
                    await Task.Delay(TimeSpan.FromSeconds(3), ct);
                    continue;
                }
                throw;
            }
        }

        long added = 0;
        var ok = 0;
        for (var i = 0; i < keys.Length; i++)
        {
            var data = result!.Data[i];
            if (data == null) continue;
            var path = AudioStore.PathFor(job.BookId, job.Voice, keys[i]);
            var tmp = path + ".part";
            await File.WriteAllBytesAsync(tmp, data, CancellationToken.None);
            File.Move(tmp, path, true);
            AudioStore.MarkSaved(job.BookId, job.Voice, keys[i]);
            AudioStore.SetFp(job.BookId, job.Voice, keys[i], result!.Fps?[i]);   // что озвучено — для будущей сверки
            if (job.Refresh?.Contains(keys[i]) ?? false) AudioStore.RemoveAliases(job.BookId, job.Voice, items[i].Text, items[i].Pause);
            saved.Add(keys[i]);
            added += data.Length;
            ok++;
        }
        bool save;
        lock (sync)
        {
            cur.Done += ok;
            cur.JobDone += keys.Length;
            cur.Bytes += added;
            save = cur.JobDone % (TtsClient.BatchSize * 8) < keys.Length;
        }
        if (ok < keys.Length)
            lock (sync) errors[job.BookId + "|" + job.Voice] = $"сервер не смог озвучить фраз: {keys.Length - ok} (будут запрошены при чтении)";
        if (save) SavePack(cur);
        Notify(job.BookId);
    }

    // ---------- связь с плеером ----------

    readonly Dictionary<string, int> priorityPos = new(); // «книга|голос» → откуда сейчас слушают

    static void Reorder(Live cur, int pos)
    {
        // сначала фразы от места чтения и дальше (по порядку), потом — то, что раньше
        var ahead = cur.Pending.Where(p => p.Pos >= pos).OrderBy(p => p.Pos);
        var behind = cur.Pending.Where(p => p.Pos < pos).OrderBy(p => p.Pos);
        var list = ahead.Concat(behind).ToList();
        cur.Pending.Clear();
        cur.Pending.AddRange(list);
    }

    /// <summary>Пользователь слушает книгу с фразы pos — если она сейчас качается этим голосом, качать сначала отсюда.</summary>
    public void Prioritize(string bookId, string voice, int pos)
    {
        lock (sync)
        {
            priorityPos[bookId + "|" + voice] = pos;
            if (live != null && live.Job.BookId == bookId && live.Job.Voice == voice) Reorder(live, pos);
        }
    }

    /// <summary>
    /// Фраза стоит в текущей загрузке (ждёт или уже запрошена у сервера)? Тогда вернуть задачу «файл сохранён»,
    /// чтобы плеер подождал её, а не синтезировал ту же фразу второй раз. null — фраза не в загрузке.
    /// </summary>
    public Task<bool>? WaitFor(string bookId, string voice, string key)
    {
        lock (sync)
        {
            if (live == null || live.Job.BookId != bookId || live.Job.Voice != voice || net != NetState.Ok) return null;
            if (!live.PendingKeys.Contains(key) && !live.InFlight.Contains(key)) return null;
            if (!live.Waiters.TryGetValue(key, out var w))
                live.Waiters[key] = w = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            return w.Task;
        }
    }

    void SavePack(Live cur, bool final = false)
    {
        try
        {
            AudioStore.PackInfo info;
            lock (sync)
                info = new AudioStore.PackInfo
                {
                    Voice = cur.Job.Voice, Title = cur.Job.Title,
                    Total = cur.Total, Done = cur.Done, Bytes = cur.Bytes,
                };
            // папку могли удалить (кнопка «Удалить озвучку») — не воскрешаем её
            if (info.Total > 0 && Directory.Exists(AudioStore.PackDir(cur.Job.BookId, cur.Job.Voice)))
                AudioStore.WritePack(cur.Job.BookId, info);
            // отпечатки большой книги — мегабайты: пишем не чаще раза в 20 с и в конце задания
            if (final || Environment.TickCount64 - cur.FpSavedAt > 20_000)
            {
                cur.FpSavedAt = Environment.TickCount64;
                AudioStore.SaveFps(cur.Job.BookId, cur.Job.Voice);
            }
        }
        catch { }
    }

    // ---------- «Освободить место» (настройки) ----------

    /// <summary>Что можно удалить: озвучка книг, которых нет в библиотеке; старый вариант фраз, ожидающих обновления;
    /// недописанные и временные файлы; всё вместе. Ничего не удаляет.</summary>
    public string CleanupInfo(HashSet<string> library)
    {
        long orphan = 0, outdated = 0, temp = 0;
        int orphanBooks = 0, outdatedPhrases = 0;
        foreach (var b in AudioStore.BookIds())
        {
            if (!library.Contains(b)) { orphan += AudioStore.BookBytes(b); orphanBooks++; continue; }
            foreach (var v in AudioStore.VoicesOf(b))
            {
                if (Busy(b, v)) continue;
                var (keys, bytes) = AudioStore.OutdatedFiles(b, v);
                outdatedPhrases += keys.Count;
                outdated += bytes;
            }
        }
        foreach (var f in TempFiles()) try { temp += new FileInfo(f).Length; } catch { }
        return JsonSerializer.Serialize(new
        {
            orphanBytes = orphan, orphanBooks, outdatedBytes = outdated, outdatedPhrases, tempBytes = temp,
            totalBytes = AudioStore.TotalBytes(), busy = IsActive,
        });
    }

    /// <summary>Удалить выбранное. Озвучку, которая сейчас качается, не трогаем. → { freed } (байт).</summary>
    public string Cleanup(HashSet<string> library, bool orphans, bool outdated, bool temp, bool all)
    {
        long freed = 0;
        if (all)
        {
            freed = AudioStore.TotalBytes();
            DeleteAll();
            foreach (var f in TempFiles()) freed += TryDelete(f);
            return JsonSerializer.Serialize(new { freed });
        }
        var touched = new HashSet<string>();
        foreach (var b in AudioStore.BookIds())
        {
            if (!library.Contains(b))
            {
                if (orphans && !BusyBook(b)) { freed += AudioStore.BookBytes(b); AudioStore.DeleteBook(b); }
                continue;
            }
            if (!outdated) continue;
            foreach (var v in AudioStore.VoicesOf(b))
            {
                if (Busy(b, v)) continue;
                var (keys, bytes) = AudioStore.OutdatedFiles(b, v);
                if (keys.Count == 0) continue;
                foreach (var k in keys) AudioStore.RemovePhrase(b, v, k);   // эти фразы прозвучат с сервера — уже по-новому
                AudioStore.SaveFps(b, v);
                AudioStore.Recount(b, v);
                freed += bytes;
                touched.Add(b);
            }
        }
        if (temp) foreach (var f in TempFiles()) freed += TryDelete(f);
        foreach (var b in touched) Notify(b, force: true);
        return JsonSerializer.Serialize(new { freed });
    }

    bool Busy(string bookId, string voice)
    {
        lock (sync)
            return (live != null && live.Job.BookId == bookId && live.Job.Voice == voice) ||
                   queue.Any(j => j.BookId == bookId && j.Voice == voice) || checking.Contains(bookId + "|" + voice);
    }

    bool BusyBook(string bookId)
    {
        lock (sync) return (live != null && live.Job.BookId == bookId) || queue.Any(j => j.BookId == bookId);
    }

    /// <summary>Временные файлы: недописанная озвучка (.part) и файлы очереди загрузки, если она пуста.</summary>
    List<string> TempFiles()
    {
        var list = AudioStore.PartFiles();
        if (!IsActive)
        {
            var dir = Path.Combine(FileSystem.CacheDirectory, "dlqueue");
            try { if (Directory.Exists(dir)) list.AddRange(Directory.GetFiles(dir)); } catch { }
        }
        return list;
    }

    static long TryDelete(string f)
    {
        try { var n = new FileInfo(f).Length; File.Delete(f); return n; } catch { return 0; }
    }

    // ---------- обновление скачанной озвучки (шаг 5 спецификации 1.2.0) ----------

    readonly HashSet<string> checking = new();            // «книга|голос», которые сейчас сверяются
    readonly Dictionary<string, int> checkPct = new();    // … и сколько процентов фраз уже сверено (для интерфейса)

    /// <summary>
    /// Сверить скачанную озвучку открытой книги (все голоса) с текущими правилами и нормализатором сервера.
    /// Только если с прошлой сверки что-то изменилось; результат — отметка «ожидает обновления» в интерфейсе.
    /// Ничего не скачивает и не удаляет.
    /// </summary>
    public void CheckLater(string bookId, IReadOnlyList<PlaybackEngine.Seg> segs)
    {
        if (string.IsNullOrEmpty(bookId) || segs.Count == 0) return;
        _ = Task.Run(async () =>
        {
            List<string> voices;
            try { voices = AudioStore.AllPacks().Where(p => p.BookId == bookId).Select(p => p.Info.Voice).ToList(); }
            catch { return; }
            foreach (var v in voices)
                try { await CheckAsync(bookId, v, segs); }
                catch (Exception ex) { DevLog.Write($"сверка озвучки {bookId}/{v}: {TtsClient.Friendly(ex)}"); }
        });
    }

    async Task CheckAsync(string bookId, string voice, IReadOnlyList<PlaybackEngine.Seg> segs, CancellationToken ct = default)
    {
        var id = bookId + "|" + voice;
        lock (sync)
        {
            if (live != null && live.Job.BookId == bookId && live.Job.Voice == voice) return;   // качается — сверим потом
            if (!checking.Add(id)) return;
        }
        try
        {
            var norm = await tts.NormVersionAsync(ct);
            if (string.IsNullOrEmpty(norm)) return;                       // нет сервера или он до 1.2.0
            var stamp = PronStore.Stamp(bookId);
            var (oldNorm, oldStamp, fps) = AudioStore.FpSnapshot(bookId, voice);
            if (fps.Count == 0) return;                                   // отпечатков нет (скачано до 1.2.0) — сверять нечего
            if (oldNorm == norm && oldStamp == stamp) return;             // с прошлой сверки ничего не менялось
            var keys = AudioStore.KeysOf(segs);
            var texts = new List<string>();
            var order = new List<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (var i = 0; i < keys.Length; i++)
            {
                var k = AudioStore.ExistingAt(bookId, voice, segs, i, ct);   // файл фразы (пауза могла смениться)
                if (k != null && fps.ContainsKey(k) && seen.Add(k)) { order.Add(k); texts.Add(segs[i].Text); }
            }
            lock (sync) checkPct[id] = 0;
            Notify(bookId, force: true);
            var (version, now) = await tts.TextFpAsync(texts, bookId, ct, (done, total) =>
            {
                lock (sync) checkPct[id] = total == 0 ? 100 : done * 100 / total;
                Notify(bookId);
            });
            var stale = new List<string>();
            for (var i = 0; i < order.Count; i++)
                if (!string.IsNullOrEmpty(now[i]) && now[i] != fps[order[i]]) stale.Add(order[i]);
            AudioStore.SetChecked(bookId, voice, string.IsNullOrEmpty(version) ? norm : version, stamp, stale);
            DevLog.Write($"сверка озвучки {bookId}/{voice}: фраз {order.Count}, устарело {stale.Count}");
        }
        finally
        {
            bool shown;
            lock (sync) { checking.Remove(id); shown = checkPct.Remove(id); }
            if (shown) Notify(bookId, force: true);
        }
    }

    /// <summary>
    /// «Обновить»: скачать заново устаревшие фразы и фразы без отпечатка (скачаны до 1.2.0). Пока не пришла новая,
    /// играет старая. Фразы, которых в книге больше нет, удаляются. false — обновлять нечего.
    /// </summary>
    public bool Refresh(string bookId, string title, string voice, IReadOnlyList<PlaybackEngine.Seg> segs)
    {
        var outdated = AudioStore.OutdatedKeys(bookId, voice);
        if (outdated.Count == 0) return false;
        // файл фразы может лежать под ключом с другой паузой (см. AudioStore.Existing): обновляем по ключу фразы книги,
        // старый вариант удаляется, когда придёт новый
        var keys = AudioStore.KeysOf(segs);
        var inBook = new HashSet<string>(StringComparer.Ordinal);
        var refresh = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < segs.Count; i++)
        {
            var file = AudioStore.ExistingAt(bookId, voice, segs, i);
            if (file == null) continue;
            inBook.Add(file);
            if (outdated.Contains(file)) refresh.Add(keys[i]);
        }
        foreach (var k in outdated.Where(k => !inBook.Contains(k)).ToList()) AudioStore.RemovePhrase(bookId, voice, k);   // фраз больше нет в книге
        AudioStore.SaveFps(bookId, voice);
        if (refresh.Count == 0) { Notify(bookId, force: true); return false; }
        Start(new Job(bookId, title, voice, segs, 0, segs.Count, null, refresh, RefreshOnly: true));
        return true;
    }
}
