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
    /// <summary>Задание: фразы либо в памяти (открытая книга), либо в файле (групповая загрузка — память не занимаем).</summary>
    public sealed record Job(string BookId, string Title, string Voice, IReadOnlyList<PlaybackEngine.Seg>? Segs, int From, int To,
        string? SegsFile = null);

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
                    queue[same] = job with { From = Math.Min(old.From, job.From), To = Math.Max(old.To, job.To) };
                }
                else queue.Add(job);
                run = !runnerActive;
                if (run) runnerActive = true;
            }
        }
        Notify(job.BookId, force: true);
        if (run) _ = Task.Run(RunAsync); // подсчёт уже загруженного и сеть — не в потоке интерфейса
    }

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
            if (cur.PendingKeys.Contains(k) || cur.InFlight.Contains(k) || AudioStore.Has(cur.Job.BookId, cur.Job.Voice, k)) continue;
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
                var r = Row(live.Job.BookId, live.Job.Voice, live.Total, live.Done, live.Bytes);
                r["running"] = true;
                r["paused"] = net != NetState.Ok;
                r["jobDone"] = live.JobDone;
                r["jobTotal"] = live.JobTotal;
                rows[key] = r;
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

    static Dictionary<string, object?> Row(string bookId, string voice, int total, int done, long bytes) => new()
    {
        ["bookId"] = bookId, ["voice"] = voice, ["total"] = total, ["done"] = done, ["bytes"] = bytes,
        ["running"] = false, ["queued"] = false, ["paused"] = false, ["jobDone"] = 0, ["jobTotal"] = 0, ["error"] = null,
    };

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
                    SavePack(cur);
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
        var have = cur.All.Keys.Where(k => AudioStore.Has(job.BookId, job.Voice, k)).ToHashSet();
        var seen = new HashSet<string>();
        var todo = ranged.Where(r => !have.Contains(r.Key) && seen.Add(r.Key)).ToList();

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
        List<byte[]?>? result = null;
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
            var data = result![i];
            if (data == null) continue;
            var path = AudioStore.PathFor(job.BookId, job.Voice, keys[i]);
            var tmp = path + ".part";
            await File.WriteAllBytesAsync(tmp, data, CancellationToken.None);
            File.Move(tmp, path, true);
            AudioStore.MarkSaved(job.BookId, job.Voice, keys[i]);
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

    void SavePack(Live cur)
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
        }
        catch { }
    }
}
