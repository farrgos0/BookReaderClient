using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace BookReaderClient.Services;

/// <summary>Включён режим «Без сервера» — в сеть не ходим.</summary>
public sealed class OfflineModeException(string message) : InvalidOperationException(message);

/// <summary>Понятная ошибка сервера (текст уже для человека).</summary>
public sealed class ServerException(string message, HttpStatusCode? code = null, TimeSpan? retryAfter = null) : InvalidOperationException(message)
{
    public HttpStatusCode? Code { get; } = code;
    /// <summary>429 «сервер занят»: через сколько повторить (запрос не ошибочный, просто очередь).</summary>
    public TimeSpan RetryAfter { get; } = retryAfter ?? TimeSpan.FromSeconds(3);
    public bool IsBusy => Code == HttpStatusCode.TooManyRequests;
}

/// <summary>HTTP-клиент сервера озвучки BookReader (server.py на ПК).</summary>
public sealed class TtsClient
{
    static readonly HttpClient Http = Make(TimeSpan.FromSeconds(90));
    // пакеты фраз для предзагрузки книги: на процессоре сервер может считать их минуту-другую
    // (а если качают несколько устройств сразу — фразы выдаются им по очереди, пакет идёт дольше)
    static readonly HttpClient BatchHttp = Make(TimeSpan.FromMinutes(10));

    /// <summary>Постоянный номер этого устройства: сервер по нему делит очередь озвучки между устройствами поровну.</summary>
    static string ClientId
    {
        get
        {
            var id = Preferences.Default.Get("clientId", "");
            if (id.Length == 0) Preferences.Default.Set("clientId", id = Guid.NewGuid().ToString("N"));
            return id;
        }
    }

    static HttpClient Make(TimeSpan timeout)
    {
        var h = new HttpClient { Timeout = timeout };
        try { h.DefaultRequestHeaders.TryAddWithoutValidation("X-BookReader-Client", ClientId); } catch { }
        return h;
    }

    /// <summary>Сколько фраз в одном пакетном запросе.</summary>
    public const int BatchSize = 16;

    static string Url(string path, string? baseUrl = null)
    {
        // проверки из окна подключения (baseUrl задан явно) работают и в режиме «Без сервера»
        if (baseUrl == null && AppSettings.Offline)
            throw new OfflineModeException("включён режим «Без сервера» (Настройки → Сервер озвучки)");
        var b = baseUrl ?? AppSettings.BaseUrl;
        if (string.IsNullOrEmpty(b)) throw new InvalidOperationException("адрес сервера не задан — откройте настройки подключения (⚙)");
        return b + path;
    }

    /// <summary>GET /api/info — голоса и состояние сервера (строка JSON как есть).</summary>
    public async Task<string> InfoAsync(CancellationToken ct = default, string? baseUrl = null)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(6));
        using var resp = await Http.GetAsync(Url("/api/info", baseUrl), cts.Token);
        await CheckAsync(resp, "/api/info", cts.Token);
        var json = await resp.Content.ReadAsStringAsync(cts.Token);
        if (baseUrl == null) Preferences.Default.Set("lastInfo", json); // голоса пригодятся без сервера
        return json;
    }

    /// <summary>Последний успешный ответ /api/info (для работы без сервера со скачанными книгами).</summary>
    public static string? CachedInfo => Preferences.Default.Get<string?>("lastInfo", null);

    /// <summary>GET /api/ping — быстрая проверка, что это сервер BookReader.</summary>
    public async Task<(string Json, TimeSpan Time)> PingAsync(string baseUrl, CancellationToken ct = default)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(5));
        var sw = System.Diagnostics.Stopwatch.StartNew();
        using var resp = await Http.GetAsync(Url("/api/ping", baseUrl), cts.Token);
        await CheckAsync(resp, "/api/ping", cts.Token);
        return (await resp.Content.ReadAsStringAsync(cts.Token), sw.Elapsed);
    }

    /// <summary>POST /api/tts — синтез фрагмента, ответ — Ogg Opus (или WAV, если на сервере нет ffmpeg).</summary>
    public async Task<byte[]> SynthAsync(string text, string speaker, double pause, CancellationToken ct = default, string? baseUrl = null,
        string? bookId = null, System.Text.Json.Nodes.JsonArray? extraRules = null)
    {
        // StringContent — с заголовком Content-Length (JsonContent шлёт потоком без длины)
        var req = new System.Text.Json.Nodes.JsonObject { ["text"] = text, ["speaker"] = speaker, ["pause"] = pause, ["format"] = "opus" };
        PronStore.Attach(req, bookId);                    // личные правила произношения для этой книги
        if (extraRules != null) req["rules"] = extraRules;  // «прослушать» в окне «Произношение»
        var json = req.ToJsonString();
        using var body = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
        using var resp = await Http.PostAsync(Url("/api/tts", baseUrl), body, ct);
        await CheckAsync(resp, "/api/tts", ct);
        return await resp.Content.ReadAsByteArrayAsync(ct);
    }

    /// <summary>POST /api/tts_batch — пакет фраз. Ответ: для каждой 4 байта длины + файл; null — фраза не удалась.</summary>
    /// <param name="live">фразы нужны для чтения прямо сейчас — сервер ставит их впереди предзагрузки</param>
    public async Task<BatchResult> SynthBatchAsync(IReadOnlyList<(string Text, double Pause)> items, string speaker, CancellationToken ct = default, bool live = false,
        string? bookId = null)
    {
        var req = new System.Text.Json.Nodes.JsonObject
        {
            ["speaker"] = speaker,
            ["format"] = "opus",
            ["live"] = live,
            ["items"] = new System.Text.Json.Nodes.JsonArray(items.Select(i =>
                (System.Text.Json.Nodes.JsonNode)new System.Text.Json.Nodes.JsonObject { ["text"] = i.Text, ["pause"] = i.Pause }).ToArray()),
        };
        PronStore.Attach(req, bookId);
        var json = req.ToJsonString();
        using var body = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
        using var resp = await BatchHttp.PostAsync(Url("/api/tts_batch"), body, ct);
        await CheckAsync(resp, "/api/tts_batch", ct);
        var data = await resp.Content.ReadAsByteArrayAsync(ct);
        var result = new List<byte[]?>(items.Count);
        var pos = 0;
        while (pos + 4 <= data.Length && result.Count < items.Count)
        {
            var len = BitConverter.ToInt32(data, pos);
            pos += 4;
            if (len < 0 || pos + len > data.Length) throw new InvalidDataException("ответ сервера обрезан");
            result.Add(len == 0 ? null : data.AsSpan(pos, len).ToArray());
            pos += len;
        }
        if (result.Count != items.Count) throw new InvalidDataException("ответ сервера обрезан");
        // отпечатки озвученного текста (сервер 1.2.0+): по ним потом находим устаревшую скачанную озвучку
        string[]? fps = null;
        if (resp.Headers.TryGetValues("X-Text-Fp", out var fv))
        {
            var parts = string.Join(",", fv).Split(',');
            if (parts.Length == items.Count) fps = parts;
        }
        var norm = resp.Headers.TryGetValues("X-Norm-Version", out var nv) ? nv.FirstOrDefault() : null;
        return new BatchResult(result, fps, norm);
    }

    /// <summary>Ответ пакета: озвучка фраз, их отпечатки (null — старый сервер) и версия нормализатора.</summary>
    public sealed record BatchResult(List<byte[]?> Data, string[]? Fps, string? Norm);

    /// <summary>Версия нормализатора сервера (из /api/ping); null — режим «Без сервера» или сервер до 1.2.0.</summary>
    public async Task<string?> NormVersionAsync(CancellationToken ct = default)
    {
        if (AppSettings.Offline || !AppSettings.HasServer) return null;
        var (json, _) = await PingAsync(AppSettings.BaseUrl, ct);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.TryGetProperty("norm", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null;
    }

    /// <summary>
    /// POST /api/text_fp — отпечатки того, что прозвучит для каждой фразы при текущих правилах книги (без озвучки).
    /// Шлём частями, чтобы запрос не был слишком большим.
    /// </summary>
    public async Task<(string Version, string[] Fps)> TextFpAsync(IReadOnlyList<string> texts, string? bookId, CancellationToken ct = default,
        Action<int, int>? progress = null)
    {
        var all = new string[texts.Count];
        var version = "";
        var off = 0;
        while (off < texts.Count)
        {
            var arr = new System.Text.Json.Nodes.JsonArray();
            var chars = 0;
            var n = 0;
            while (off + n < texts.Count && n < 1000 && (n == 0 || chars + texts[off + n].Length < 1_000_000))
            {
                chars += texts[off + n].Length;
                arr.Add(texts[off + n]);
                n++;
            }
            var req = new System.Text.Json.Nodes.JsonObject { ["items"] = arr };
            PronStore.Attach(req, bookId);
            using var body = new StringContent(req.ToJsonString(), System.Text.Encoding.UTF8, "application/json");
            using var resp = await BatchHttp.PostAsync(Url("/api/text_fp"), body, ct);
            await CheckAsync(resp, "/api/text_fp", ct);
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
            version = doc.RootElement.GetProperty("version").GetString() ?? "";
            var i = 0;
            foreach (var e in doc.RootElement.GetProperty("fps").EnumerateArray())
            {
                if (i < n) all[off + i] = e.GetString() ?? "";
                i++;
            }
            if (i != n) throw new InvalidDataException("ответ сервера обрезан");
            off += n;
            progress?.Invoke(off, texts.Count);
        }
        return (version, all);
    }

    /// <summary>GET /api/catalog — книги из папки catalog на сервере (строка JSON как есть).</summary>
    public async Task<string> CatalogAsync(CancellationToken ct = default)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(60)); // первый просмотр папки сервер считает хэши файлов
        using var resp = await Http.GetAsync(Url("/api/catalog"), cts.Token);
        await CheckAsync(resp, "/api/catalog", cts.Token);
        return await resp.Content.ReadAsStringAsync(cts.Token);
    }

    /// <summary>GET /api/catalog/file/{id} — скачать книгу из каталога во временный файл.</summary>
    public async Task DownloadCatalogFileAsync(string id, string destPath, CancellationToken ct = default)
    {
        using var resp = await BatchHttp.GetAsync(Url("/api/catalog/file/" + Uri.EscapeDataString(id)), HttpCompletionOption.ResponseHeadersRead, ct);
        await CheckAsync(resp, "/api/catalog/file", ct);
        await using var src = await resp.Content.ReadAsStreamAsync(ct);
        await using var dst = File.Create(destPath);
        await src.CopyToAsync(dst, ct);
    }

    static string Trim(string s) => s.Length > 200 ? s[..200] + "…" : s;

    /// <summary>Ответ не 2xx → ServerException с человеческим текстом (вместо «Response status code 500»).</summary>
    static async Task CheckAsync(HttpResponseMessage resp, string api, CancellationToken ct)
    {
        if (resp.IsSuccessStatusCode) return;
        string detail = "";
        try
        {
            var body = await resp.Content.ReadAsStringAsync(ct);
            try { detail = JsonDocument.Parse(body).RootElement.GetProperty("error").GetString() ?? ""; }
            catch { detail = body.TrimStart().StartsWith('<') ? "" : Trim(body.Trim()); }
        }
        catch { }
        var code = (int)resp.StatusCode;
        var msg = code switch
        {
            404 when api == "/api/catalog" => detail.Contains("выключен")
                ? "каталог на сервере выключен (сервер запущен с --no-catalog)"
                : "на сервере нет каталога книг — обновите BookReader на ПК (нужна версия 1.3)",
            404 when api == "/api/catalog/file" => "этой книги уже нет в каталоге сервера — обновите список",
            404 or 501 when api == "/api/tts_batch" => "сервер BookReader устарел — обновите его на ПК (нужна версия 1.2)",
            404 or 405 or 501 => "по этому адресу отвечает не сервер BookReader или он устарел — проверьте адрес и обновите сервер",
            400 => "сервер не понял запрос" + (detail.Length > 0 ? ": " + detail : ""),
            401 or 403 => "сервер отказал в доступе",
            413 => "запрос слишком большой для сервера",
            429 => detail.Length > 0 ? detail : "сервер занят озвучкой для других устройств — повторю чуть позже",
            500 when api.StartsWith("/api/tts") => "сервер не смог озвучить текст" + (detail.Length > 0 ? ": " + detail : "") + ". Подробности — в окне сервера на ПК",
            500 => "внутренняя ошибка сервера" + (detail.Length > 0 ? ": " + detail : "") + ". Подробности — в окне сервера на ПК",
            502 or 503 or 504 => "сервер перегружен или перезапускается — попробуйте через минуту",
            _ => $"сервер ответил ошибкой (код {code})" + (detail.Length > 0 ? ": " + detail : ""),
        };
        var retry = resp.Headers.RetryAfter?.Delta;
        if (retry is { } r) retry = TimeSpan.FromSeconds(Math.Clamp(r.TotalSeconds, 1, 60));
        throw new ServerException(msg, resp.StatusCode, retry);
    }

    /// <summary>Понятное сообщение об ошибке сети/сервера — без кодов и английских текстов исключений.</summary>
    public static string Friendly(Exception ex, string? baseUrl = null)
    {
        var b = baseUrl ?? AppSettings.BaseUrl;
        var addr = string.IsNullOrEmpty(b) ? "сервер" : $"сервер {b}";
        if (ex is AggregateException { InnerException: { } inner }) ex = inner;
        switch (ex)
        {
            case OfflineModeException or ServerException:
                return ex.Message;
            case TaskCanceledException or TimeoutException:
                return $"{addr} не ответил вовремя — он перегружен или связь слишком медленная";
            case HttpRequestException h when h.StatusCode is null:
                return NoConnection(b, h);
            case HttpRequestException h:
                return $"{addr} ответил ошибкой (код {(int)h.StatusCode!})";
            case SocketException se:
                return NoConnection(b, se);
            case IOException io when io.InnerException is SocketException:
                return $"связь с сервером{(string.IsNullOrEmpty(b) ? "" : " " + b)} оборвалась — проверьте Wi-Fi и что сервер запущен";
            case JsonException:
                return $"{addr} прислал непонятный ответ — возможно, по этому адресу не BookReader";
            case InvalidDataException:
                return ex.Message;
            case UnauthorizedAccessException:
                return "нет доступа к файлу на устройстве";
            case IOException io when io.Message.Contains("space", StringComparison.OrdinalIgnoreCase):
                return "на устройстве закончилось место";
            case InvalidOperationException:
                return ex.Message;
            default:
                return ex.Message;
        }
    }

    static string NoConnection(string? baseUrl, Exception ex)
    {
        var se = ex as SocketException ?? ex.InnerException as SocketException ?? ex.InnerException?.InnerException as SocketException;
        var hint = se?.SocketErrorCode switch
        {
            SocketError.ConnectionRefused => "компьютер доступен, но сервер не запущен — запустите BookReader.bat на ПК",
            SocketError.HostUnreachable or SocketError.NetworkUnreachable => "компьютер с сервером не виден в сети — проверьте Wi-Fi / точку доступа и адрес",
            SocketError.TimedOut => "компьютер не отвечает — он выключен, спит или его закрывает брандмауэр",
            SocketError.HostNotFound or SocketError.NoData or SocketError.TryAgain => "такого адреса нет — проверьте его в настройках подключения",
            SocketError.NetworkDown => "на телефоне нет сети",
            SocketError.ConnectionReset or SocketError.ConnectionAborted => "связь оборвалась — сервер перезапустили или пропал Wi-Fi",
            _ => "проверьте, что ПК включён, BookReader.bat запущен и телефон в той же сети",
        };
        return $"нет связи с сервером{(string.IsNullOrEmpty(baseUrl) ? "" : " " + baseUrl)}: {hint}";
    }
}
