using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Text.Json;
using BookReaderClient.Services;

namespace BookReaderClient.Bridge;

/// <summary>
/// Методы, которые веб-часть вызывает через window.HybridWebView.InvokeDotNet (см. web/native.js).
/// Все параметры приходят строками. Долгие операции (сеть, выбор файлов) отвечают асинхронно:
/// метод сразу возвращается, а результат приходит в JS через __native.resolve(reqId, json).
/// </summary>
[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)]
public sealed class JsBridge(MainPage page)
{
    // ---------- транспорт ----------
    // На Android HybridWebView передаёт аргументы в HTTP-заголовке, а там допустима только латиница.
    // Поэтому web/native.js упаковывает аргументы: JSON → UTF-8 → base64, большие — по частям.

    readonly Dictionary<string, StringBuilder> parts = new();

    /// <summary>Единая точка входа: method + base64(UTF-8(JSON-массив строк)). Ответ — тоже base64(UTF-8).</summary>
    public string? Call(string method, string payload) => Pack(Dispatch(method, Unpack(payload)));

    /// <summary>Как Call, но ответ без упаковки: только для методов, которые сами возвращают латиницу (base64 файла).</summary>
    public string? CallRaw(string method, string payload) =>
        method is nameof(LibReadChunk) ? Dispatch(method, Unpack(payload)) : throw new InvalidOperationException("CallRaw: недопустимый метод " + method);

    public string CallBegin()
    {
        var token = Guid.NewGuid().ToString("N");
        lock (parts) parts[token] = new StringBuilder();
        return token;
    }

    public void CallPart(string token, string part)
    {
        lock (parts) parts[token].Append(part);
    }

    public string? CallEnd(string token, string method)
    {
        string payload;
        lock (parts) { payload = parts[token].ToString(); parts.Remove(token); }
        return Call(method, payload);
    }

    static string?[] Unpack(string payload)
    {
        var json = Encoding.UTF8.GetString(Convert.FromBase64String(payload));
        return JsonSerializer.Deserialize<string?[]>(json) ?? [];
    }

    static string? Pack(string? result) => result == null ? null : Convert.ToBase64String(Encoding.UTF8.GetBytes(result));

    string? Dispatch(string method, string?[] args)
    {
        if (method is nameof(Call) or nameof(CallRaw) or nameof(CallBegin) or nameof(CallPart) or nameof(CallEnd))
            throw new InvalidOperationException("недопустимый метод " + method);
        var mi = typeof(JsBridge).GetMethod(method, BindingFlags.Public | BindingFlags.Instance)
                 ?? throw new MissingMethodException(nameof(JsBridge), method);
        var ps = mi.GetParameters();
        var values = new object?[ps.Length];
        for (var i = 0; i < ps.Length; i++) values[i] = i < args.Length ? args[i] : null;
        try
        {
            return mi.Invoke(this, values)?.ToString();
        }
        catch (TargetInvocationException e) when (e.InnerException != null)
        {
            ExceptionDispatchInfo.Capture(e.InnerException).Throw();
            throw;
        }
    }

    static LibraryStore Lib => AppServices.Library;
    static PlaybackEngine Engine => AppServices.Engine;

    // ---------- библиотека ----------
    public string LibList() => Lib.ListJson();
    public string? LibGet(string id) => Lib.GetJson(id);
    public string? LibFileInfo(string id) => Lib.FileInfoJson(id);
    public string LibReadChunk(string id, string offset, string length) =>
        Lib.ReadChunkBase64(id, long.Parse(offset, CultureInfo.InvariantCulture), int.Parse(length, CultureInfo.InvariantCulture));
    public void LibUpdate(string id, string patchJson) => Lib.Update(id, patchJson);
    public string LibBeginAdd(string name, string? type, string? size) => Lib.BeginAdd(name, type ?? "");
    public void LibAppend(string token, string base64) => Lib.Append(token, base64);
    public string LibFinishAdd(string token, string metaJson) => Lib.FinishAdd(token, metaJson);
    public void LibRemove(string id)
    {
        Lib.Remove(id);
        AppServices.Preload.Delete(id, null); // скачанная озвучка уходит вместе с книгой
    }
    public void LibClear()
    {
        Lib.Clear();
        AppServices.Preload.DeleteAll();
    }
    public string LibEstimate() => Lib.EstimateJson();

    /// <summary>Экспорт: системное окно «Поделиться» с исходным файлом книги (сохранить, отправить и т. п.).</summary>
    public void LibExportAsync(string reqId, string id) => Run(reqId, async () =>
    {
        var path = Lib.ExportCopy(id);
        await MainThread.InvokeOnMainThreadAsync(() => Share.Default.RequestAsync(new ShareFileRequest
        {
            Title = "Файл книги",
            File = new ShareFile(path),
        }));
        return "\"ok\"";
    });

    /// <summary>«Поделиться» сразу несколькими книгами (выбор нескольких в библиотеке).</summary>
    public void LibExportManyAsync(string reqId, string idsJson) => Run(reqId, async () =>
    {
        var ids = JsonSerializer.Deserialize<string[]>(idsJson) ?? [];
        var files = new List<ShareFile>();
        for (var i = 0; i < ids.Length; i++)
        {
            try { files.Add(new ShareFile(Lib.ExportCopy(ids[i], clean: i == 0))); }
            catch { } // книга могла исчезнуть — делимся остальными
        }
        if (files.Count == 0) throw new InvalidOperationException("файлы выбранных книг не найдены");
        await MainThread.InvokeOnMainThreadAsync(() => Share.Default.RequestAsync(new ShareMultipleFilesRequest
        {
            Title = files.Count == 1 ? "Файл книги" : $"Файлы книг ({files.Count})",
            Files = files,
        }));
        return "\"ok\"";
    });

    public void LibPickFilesAsync(string reqId) => Run(reqId, async () =>
        await MainThread.InvokeOnMainThreadAsync(() => Lib.PickFilesJson()));

    // ---------- плеер ----------
    // Фразы недавно открытых книг: при возврате к книге JS присылает только подпись (sig), а не всю книгу заново —
    // на больших книгах это сотни килобайт через мост и заметная задержка при переключении.
    static readonly object queueLock = new();
    // смена книги в плеере — строго по одной (мост может вызвать методы из разных потоков одновременно)
    static readonly SemaphoreSlim queueGate = new(1, 1);
    static readonly List<(string BookId, string Sig, List<PlaybackEngine.Seg> Segs)> queueCache = new();

    public void PlayerSetQueue(string bookId, string title, string segsJson, string? sig)
    {
        var raw = JsonSerializer.Deserialize<JsonElement[][]>(segsJson) ?? [];
        var segs = raw.Select(a => new PlaybackEngine.Seg(
            a.Length > 0 ? a[0].GetString() ?? "" : "",
            a.Length > 1 && a[1].ValueKind == JsonValueKind.Number ? a[1].GetDouble() : 0.2)).ToList();
        if (!string.IsNullOrEmpty(sig))
            lock (queueLock)
            {
                queueCache.RemoveAll(q => q.BookId == bookId);
                queueCache.Add((bookId, sig, segs));
                while (queueCache.Count > 4) queueCache.RemoveAt(0);
            }
        queueGate.Wait();
        try { Engine.SetQueue(bookId, title, segs); }
        finally { queueGate.Release(); }
    }

    /// <summary>Книга уже присылалась с той же подписью — берём её фразы из памяти. "1" — готово, "0" — пришлите целиком.</summary>
    public string PlayerUseQueue(string bookId, string title, string sig)
    {
        List<PlaybackEngine.Seg>? segs = null;
        lock (queueLock)
        {
            var i = queueCache.FindIndex(q => q.BookId == bookId && q.Sig == sig);
            if (i >= 0)
            {
                var hit = queueCache[i];
                queueCache.RemoveAt(i);
                queueCache.Add(hit);
                segs = hit.Segs;
            }
        }
        if (segs == null) return "0";
        queueGate.Wait();
        try
        {
            if (Engine.BookId != bookId || !ReferenceEquals(Engine.Segments, segs)) Engine.SetQueue(bookId, title, segs);
        }
        finally { queueGate.Release(); }
        return "1";
    }

    public void PlayerPlay(string index, string? voice, string? rate)
    {
        Engine.Configure(voice, rate);
        Engine.Play(Int(index));
    }

    public void PlayerResume(string index, string? voice, string? rate)
    {
        Engine.Configure(voice, rate);
        Engine.Resume(Int(index));
    }

    public void PlayerPause() => Engine.Pause();
    /// <summary>Таймер сна: минуты (0 — нет) и фраза, на которой остановиться (-1 — нет; начало следующей главы).</summary>
    public void PlayerSleep(string minutes, string? atIndex) =>
        Engine.SetSleep(int.TryParse(minutes, out var m) ? m : 0, int.TryParse(atIndex, out var a) ? a : -1);
    public void PlayerStop() => Engine.Stop();
    public void PlayerSetVoice(string voice) => Engine.SetVoice(voice);
    public void PlayerSetRate(string rate)
    {
        if (double.TryParse(rate, NumberStyles.Float, CultureInfo.InvariantCulture, out var r)) Engine.SetRate(r);
    }
    public string PlayerState() => JsonSerializer.Serialize(new { index = Engine.Index, playing = Engine.IsPlaying, loading = Engine.IsLoading });

    // ---------- сервер и настройки ----------
    /// <summary>Режим «Без сервера»: true — не ходить в сеть, читать только скачанное.</summary>
    public void SetOffline(string on)
    {
        AppSettings.Offline = on == "true";
        if (AppSettings.Offline) AppServices.Preload.CancelAll();
    }

    public string GetOffline() => AppSettings.Offline ? "true" : "false";

    /// <summary>Голоса без обращения к серверу: из последнего ответа или стандартный набор Silero.</summary>
    static string OfflineInfo(bool manual, string? error)
    {
        System.Text.Json.Nodes.JsonObject? o = null;
        try { if (TtsClient.CachedInfo is { } c) o = System.Text.Json.Nodes.JsonNode.Parse(c) as System.Text.Json.Nodes.JsonObject; }
        catch { }
        o ??= System.Text.Json.Nodes.JsonNode.Parse("""
            {"speakers":[{"id":"aidar","name":"Айдар — мужской"},{"id":"eugene","name":"Евгений — мужской"},{"id":"baya","name":"Байя — женский"},{"id":"xenia","name":"Ксения — женский"},{"id":"kseniya","name":"Ксюша — женский"}],"default":"aidar"}
            """)!.AsObject();
        o["offline"] = true;
        o["manual"] = manual;   // true — пользователь сам выбрал «Без сервера»
        if (error != null) o["error"] = error;
        return o.ToJsonString();
    }

    public void ServerInfoAsync(string reqId) => Run(reqId, async () =>
    {
        if (AppSettings.Offline) return OfflineInfo(true, null);
        try { return await AppServices.Tts.InfoAsync(); }
        catch (Exception ex)
        {
            // сервера нет — голоса из прошлого ответа: скачанные книги читаются и так
            return OfflineInfo(false, TtsClient.Friendly(ex));
        }
    });

    // ---------- скачивание озвучки ----------
    /// <summary>Скачать озвучку открытой книги: фразы с from по to (не включая), голосом voice.</summary>
    public void PreloadStart(string bookId, string title, string voice, string from, string to)
    {
        if (Engine.BookId != bookId || Engine.Segments.Count == 0)
            throw new InvalidOperationException("книга не открыта в плеере — откройте её и повторите");
        var segs = Engine.Segments; // тот же список, что у плеера: ключи фраз уже посчитаны
        var a = Math.Clamp(Int(from), 0, segs.Count);
        var b = Math.Clamp(Int(to), a, segs.Count);
        if (string.IsNullOrWhiteSpace(voice)) voice = Engine.Voice;
        AppServices.Preload.Start(new PreloadManager.Job(bookId, title, voice, segs, a, b));
    }

    public void PreloadCancel(string bookId) => AppServices.Preload.Cancel(bookId);

    /// <summary>Групповая загрузка: фразы книги уже разобраны веб-частью (книга не открыта в плеере).</summary>
    public void PreloadEnqueue(string bookId, string title, string voice, string segsJson)
    {
        var raw = JsonSerializer.Deserialize<JsonElement[][]>(segsJson) ?? [];
        var segs = raw.Select(a => new PlaybackEngine.Seg(
            a.Length > 0 ? a[0].GetString() ?? "" : "",
            a.Length > 1 && a[1].ValueKind == JsonValueKind.Number ? a[1].GetDouble() : 0.2)).ToList();
        if (segs.Count == 0) throw new InvalidOperationException("в книге не найден текст");
        // открытая сейчас книга — берём фразы плеера (те же ключи, и дозагрузка встанет в уже идущую)
        if (Engine.BookId == bookId && Engine.Segments.Count == segs.Count)
            AppServices.Preload.Start(new PreloadManager.Job(bookId, title, voice, Engine.Segments, 0, segs.Count));
        else AppServices.Preload.Enqueue(bookId, title, voice, segs);
    }

    public void PreloadCancelAll() => AppServices.Preload.CancelAll();
    public void PreloadResume() => AppServices.Preload.ResumeNow();
    public void PreloadHold() => AppServices.Preload.Hold();
    public string PreloadQueue() => AppServices.Preload.QueueJson();
    public void PreloadDelete(string bookId, string? voice) => AppServices.Preload.Delete(bookId, voice);
    public string PreloadStatus() => AppServices.Preload.StatusJson();
    /// <summary>
    /// Сколько фраз каждой главы скачано голосом voice: starts — номера первых фраз глав (JSON-массив).
    /// Ответ: [[скачано, всего], ...] по главам. Текст до первой главы относится к первой.
    /// </summary>
    /// <summary>То же, что PreloadCoverage, но считается в фоне (на книге в тысячи фраз — десятки миллисекунд).</summary>
    public void PreloadCoverageAsync(string reqId, string bookId, string voice, string startsJson) =>
        Run(reqId, () => Task.Run<string?>(() => PreloadCoverage(bookId, voice, startsJson)));

    public string PreloadCoverage(string bookId, string voice, string startsJson)
    {
        if (Engine.BookId != bookId) return "[]";
        var segs = Engine.Segments;
        var keys = AudioStore.KeysOf(segs);
        var starts = JsonSerializer.Deserialize<int[]>(startsJson) ?? [];
        var result = new List<int[]>(starts.Length);
        for (var k = 0; k < starts.Length; k++)
        {
            var a = k == 0 ? 0 : Math.Clamp(starts[k], 0, segs.Count);
            var b = k + 1 < starts.Length ? Math.Clamp(starts[k + 1], a, segs.Count) : segs.Count;
            var done = 0;
            for (var i = a; i < b; i++)
                if (AudioStore.Has(bookId, voice, keys[i])) done++;
            result.Add([done, b - a]);
        }
        return JsonSerializer.Serialize(result);
    }

    // ---------- каталог книг на сервере ----------
    public void CatalogListAsync(string reqId) => Run(reqId, async () => await AppServices.Tts.CatalogAsync());

    /// <summary>Скачать книгу из каталога сервера прямо в библиотеку. Ответ: { id, name, isNew }.</summary>
    public void CatalogFetchAsync(string reqId, string id, string name) => Run(reqId, async () =>
    {
        var safe = string.Concat((name ?? "book").Split(Path.GetInvalidFileNameChars()));
        var tmp = Path.Combine(FileSystem.CacheDirectory, "cat_" + Guid.NewGuid().ToString("N"));
        try
        {
            await AppServices.Tts.DownloadCatalogFileAsync(id, tmp);
            return Lib.AddFileJson(tmp, string.IsNullOrWhiteSpace(safe) ? "book" : safe);
        }
        catch (Exception ex)
        {
            try { File.Delete(tmp); } catch { }
            throw new InvalidOperationException(TtsClient.Friendly(ex));
        }
    });

    public string PreloadBytes() => AudioStore.TotalBytes().ToString(CultureInfo.InvariantCulture);

    public void OpenSettings(string? find) => page.OpenSettings(find == "true");

    // ---------- первый запуск ----------
    /// <summary>Флаги приложения (принято соглашение и т. п.) — в настройках устройства, не в WebView.</summary>
    public string? GetPref(string key) => Preferences.Default.Get<string?>("ui_" + key, null);
    public void SetPref(string key, string? value) => Preferences.Default.Set("ui_" + key, value);

    // ---------- личные правила произношения ----------
    /// <summary>Правила изменились (окно «Произношение» сохранено) — текущую озвучку получаем заново.</summary>
    public void PronChanged() => Engine.PronChanged();

    /// <summary>«Прослушать» правило: { b64, mime } — фраза озвучкой сервера с этим правилом.</summary>
    public void PronPreviewAsync(string reqId, string text, string voice, string extraJson) => Run(reqId, async () =>
    {
        System.Text.Json.Nodes.JsonArray? rules = null;
        try { rules = System.Text.Json.Nodes.JsonNode.Parse(extraJson)?["rules"]?.DeepClone() as System.Text.Json.Nodes.JsonArray; } catch { }
        var bytes = await AppServices.Tts.SynthAsync(text, voice, 0.1, extraRules: rules);
        var mime = bytes.Length > 4 && bytes[0] == (byte)'O' && bytes[1] == (byte)'g' ? "audio/ogg" : "audio/wav";
        return JsonSerializer.Serialize(new { b64 = Convert.ToBase64String(bytes), mime });
    });
    public string HasServer() => AppSettings.HasServer ? "true" : "false";

    /// <summary>Закрыть приложение (соглашение не принято).</summary>
    public void ExitApp() => MainThread.BeginInvokeOnMainThread(() => Application.Current?.Quit());

    /// <summary>Тема читалки сменилась: фон под системными панелями и цвет их значков.</summary>
    public void SetTheme(string bgHex, string? dark) => page.ApplyTheme(bgHex, dark == "true");

    /// <summary>Строка от веб-части в технический журнал (экран «Для разработчиков»): долгие подвисания и т. п.</summary>
    public void WebLog(string line) => DevLog.Write("веб: " + line);

    // ---------- служебное ----------
    void Run(string reqId, Func<Task<string?>> work)
    {
        _ = Task.Run(async () =>
        {
            string? result;
            string? error = null;
            try { result = await work(); }
            catch (Exception ex) { result = null; error = TtsClient.Friendly(ex); }
            page.Resolve(reqId, result, error);
        });
    }

    static int Int(string s) => int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : 0;
}
