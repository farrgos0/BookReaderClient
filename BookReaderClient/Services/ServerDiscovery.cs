using System.Collections.Concurrent;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace BookReaderClient.Services;

/// <summary>
/// Поиск сервера BookReader в локальной сети.
/// 0) Этот же ПК (приложение для Windows рядом с сервером): 127.0.0.1 — на UDP с собственного адреса сервер не отвечает.
/// 1) Широковещательный UDP-запрос «есть тут BookReader?». Ответы собираются 1,5 с целиком (а не «первый ответивший»):
///    в сети может быть несколько серверов. Дубли отсеиваются по IP и по номеру сервера (один ПК с Wi-Fi и VPN — один сервер).
/// 2) Если никто не ответил (старый сервер, сеть режет широковещание) — перебор адресов своей подсети по
///    портам BookReader: TCP-соединение, затем проверка /api/ping, что это именно BookReader.
/// </summary>
public static class ServerDiscovery
{
    /// <param name="Name">имя для списка: «BookReader (DESKTOP-1)»</param>
    /// <param name="Id">номер запуска сервера (пусто у старых серверов)</param>
    public sealed record Found(string Address, int Port, string Name, string Version, string Id = "")
    {
        public string BaseUrl => $"{Address}:{Port}";
        public bool IsThisPc => Address == "127.0.0.1";
        public string Title => (IsThisPc ? "этот компьютер · " : "") + $"{Name} — {Address}:{Port}";
    }

    /// <summary>Сколько собирать ответы на широковещательный запрос.</summary>
    const int CollectMs = 1500;

    const int DiscoveryPort = 8765;
    static readonly byte[] Magic = Encoding.ASCII.GetBytes("BOOKREADER_DISCOVER");
    /// <summary>Порты для перебора: стандартный и соседние (если 8765 был занят и сервер запущен с --port).</summary>
    public static readonly int[] Ports = [8765, 8766, 8767, 8768, 8769];

    public static async Task<List<Found>> FindAsync(IProgress<string>? progress = null, CancellationToken ct = default)
    {
        var nets = LocalNetworks();
        // сервер на этом же устройстве — проверяем напрямую, параллельно с опросом сети
        var local = ThisPcAsync(ct);
        if (nets.Count == 0)
        {
            var only = await local;
            ct.ThrowIfCancellationRequested();
            if (only.Count == 0) progress?.Report("устройство не подключено к Wi-Fi / локальной сети");
            return only;
        }
        progress?.Report("сети устройства: " + string.Join(", ", nets.Select(n => $"{n.Ip}/{n.Prefix}")));

        progress?.Report($"спрашиваю сеть (широковещательный запрос, жду ответы {CollectMs / 1000.0:0.#} с)…");
        var udp = await BroadcastAsync(nets, ct);
        var found = Merge((await local).Concat(udp), nets);
        ct.ThrowIfCancellationRequested(); // отменённый поиск ничего не возвращает
        foreach (var f in found) progress?.Report("ответил: " + f.Title);
        if (found.Count > 0) return found;

        progress?.Report("широковещательный ответ не пришёл — перебираю адреса подсети…");
        found = Merge(await SweepAsync(nets, progress, ct), nets);
        ct.ThrowIfCancellationRequested();
        return found;
    }

    /// <summary>
    /// Один сервер — одна строка: по IP (несколько пакетов от одного адреса), затем по номеру сервера
    /// (ПК в двух сетях отвечает с двух адресов) — оставляем адрес из сети этого устройства.
    /// </summary>
    static List<Found> Merge(IEnumerable<Found> all, List<Net> nets)
    {
        var byIp = new Dictionary<string, Found>();
        foreach (var f in all)
            if (!byIp.TryGetValue(f.Address, out var had) || (had.Id.Length == 0 && f.Id.Length > 0)) byIp[f.Address] = f;
        var result = new List<Found>();
        foreach (var g in byIp.Values.GroupBy(f => f.Id.Length > 0 ? f.Id : "ip:" + f.Address))
            result.Add(g.OrderByDescending(f => SameSubnet(f, nets)).ThenBy(f => f.IsThisPc ? 1 : 0).First());
        return result.OrderBy(f => f.IsThisPc ? 0 : 1).ThenBy(f => f.Name).ThenBy(f => f.Address).ToList();
    }

    static bool SameSubnet(Found f, List<Net> nets)
    {
        if (!IPAddress.TryParse(f.Address, out var ip) || ip.AddressFamily != AddressFamily.InterNetwork) return false;
        foreach (var n in nets)
        {
            var mask = uint.MaxValue << (32 - n.Prefix);
            if ((ToUInt(ip) & mask) == (ToUInt(n.Ip) & mask)) return true;
        }
        return false;
    }

    /// <summary>Сервер на этом же устройстве (Windows-приложение на ПК с сервером).</summary>
    static async Task<List<Found>> ThisPcAsync(CancellationToken ct)
    {
        var list = new List<Found>();
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            var checks = Ports.Select(async p =>
                await TcpOpenAsync(IPAddress.Loopback, p, 300, ct) ? await PingAsync(http, IPAddress.Loopback, p, ct) : null);
            foreach (var f in await Task.WhenAll(checks)) if (f != null) list.Add(f);
        }
        catch (Exception) when (!ct.IsCancellationRequested) { }
        return list;
    }

    // ---------- сети устройства ----------

    sealed record Net(IPAddress Ip, int Prefix, IPAddress Broadcast);

    static List<Net> LocalNetworks()
    {
        var list = new List<Net>();
        try
        {
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                IPInterfaceProperties props;
                try { props = ni.GetIPProperties(); } catch { continue; }
                foreach (var ua in props.UnicastAddresses)
                {
                    if (ua.Address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(ua.Address)) continue;
                    var b = ua.Address.GetAddressBytes();
                    if (b[0] == 169 && b[1] == 254) continue; // «адрес без DHCP» — сети нет
                    int prefix;
                    try { prefix = ua.PrefixLength; } catch { prefix = 24; }
                    if (prefix <= 0 || prefix > 30) prefix = 24;
                    list.Add(new Net(ua.Address, prefix, BroadcastOf(ua.Address, prefix)));
                }
            }
        }
        catch { }
        // мобильный интернет (10.x от оператора с /8) перебирать бессмысленно — оставляем, но перебор ограничим /24
        return list.DistinctBy(n => n.Ip.ToString()).ToList();
    }

    static uint ToUInt(IPAddress ip) { var b = ip.GetAddressBytes(); return (uint)(b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]); }
    static IPAddress FromUInt(uint v) => new([(byte)(v >> 24), (byte)(v >> 16), (byte)(v >> 8), (byte)v]);

    static IPAddress BroadcastOf(IPAddress ip, int prefix)
    {
        var mask = prefix == 0 ? 0u : uint.MaxValue << (32 - prefix);
        return FromUInt(ToUInt(ip) | ~mask);
    }

    // ---------- 1) UDP ----------

    static async Task<List<Found>> BroadcastAsync(List<Net> nets, CancellationToken ct)
    {
        // ключ — IP: несколько пакетов от одного сервера (повторы запроса, несколько сетей) не дают дублей
        var result = new ConcurrentDictionary<string, Found>();
        try
        {
            using var udp = new UdpClient(AddressFamily.InterNetwork) { EnableBroadcast = true };
            udp.Client.Bind(new IPEndPoint(IPAddress.Any, 0));
            var targets = nets.Select(n => n.Broadcast).Append(IPAddress.Broadcast).DistinctBy(a => a.ToString()).ToList();
            using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct);
            wait.CancelAfter(CollectMs);
            // запрос — три раза с шагом 0,5 с (первый пакет в Wi-Fi нередко теряется); слушаем все 1,5 с целиком
            var sender = Task.Run(async () =>
            {
                for (var round = 0; round < 3 && !wait.IsCancellationRequested; round++)
                {
                    foreach (var t in targets)
                    {
                        try { await udp.SendAsync(Magic, Magic.Length, new IPEndPoint(t, DiscoveryPort)); } catch { }
                    }
                    try { await Task.Delay(500, wait.Token); } catch (OperationCanceledException) { }
                }
            });
            try
            {
                while (true)
                {
                    var r = await udp.ReceiveAsync(wait.Token);
                    var f = ParseReply(r.Buffer, r.RemoteEndPoint.Address);
                    if (f != null) result.TryAdd(f.Address, f);
                }
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
            catch (SocketException) { } // сеть пропала посреди поиска — что успели собрать, то и показываем
            try { await sender; } catch { }
        }
        catch (Exception ex) when (ex is SocketException or ObjectDisposedException) { }
        return result.Values.ToList();
    }

    static Found? ParseReply(byte[] data, IPAddress from)
    {
        try
        {
            using var doc = JsonDocument.Parse(data);
            var r = doc.RootElement;
            var name = Str(r, "name");
            // новый сервер: name «BookReader (ПК)» и app «BookReader»; старый: name «BookReader» и host отдельно
            if (Str(r, "app") != "BookReader" && name != "BookReader" && !name.StartsWith("BookReader (")) return null;
            if (!r.TryGetProperty("port", out var p) || !p.TryGetInt32(out var port) || port <= 0 || port > 65535) return null;
            return new Found(from.MapToIPv4().ToString(), port, NameOf(name, Str(r, "host")), Str(r, "version"), Str(r, "id"));
        }
        catch { return null; }
    }

    // ---------- 2) перебор подсети ----------

    static async Task<List<Found>> SweepAsync(List<Net> nets, IProgress<string>? progress, CancellationToken ct)
    {
        // адреса: вся подсеть, но не больше /24 вокруг своего адреса (иначе это тысячи адресов)
        var hosts = new List<IPAddress>();
        foreach (var n in nets)
        {
            var prefix = Math.Max(n.Prefix, 24);
            var mask = uint.MaxValue << (32 - prefix);
            var start = (ToUInt(n.Ip) & mask) + 1;
            var end = (ToUInt(n.Ip) | ~mask) - 1;
            for (var a = start; a <= end; a++)
                if (a != ToUInt(n.Ip)) hosts.Add(FromUInt(a));
        }
        hosts = hosts.DistinctBy(h => h.ToString()).ToList();
        var total = hosts.Count * Ports.Length;
        var done = 0;
        var found = new ConcurrentDictionary<string, Found>();
        using var gate = new SemaphoreSlim(96);
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        var lastReport = Environment.TickCount64;

        var tasks = hosts.SelectMany(h => Ports.Select(p => (h, p))).Select(async target =>
        {
            await gate.WaitAsync(ct);
            try
            {
                if (await TcpOpenAsync(target.h, target.p, 350, ct))
                {
                    var f = await PingAsync(http, target.h, target.p, ct);
                    if (f != null)
                    {
                        found[f.BaseUrl] = f;
                        progress?.Report($"найден: {f.Title}");
                    }
                }
            }
            finally
            {
                gate.Release();
                var d = Interlocked.Increment(ref done);
                var now = Environment.TickCount64;
                if (now - Interlocked.Read(ref lastReport) > 700)
                {
                    Interlocked.Exchange(ref lastReport, now);
                    progress?.Report($"проверено {d} из {total}…");
                }
            }
        });
        try { await Task.WhenAll(tasks); }
        catch (OperationCanceledException) { }
        return found.Values.OrderBy(f => f.Address).ToList();
    }

    static string Str(JsonElement r, string prop) =>
        r.ValueKind == JsonValueKind.Object && r.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    static string NameOf(string name, string host)
    {
        if (name.StartsWith("BookReader (")) return name.Length > 80 ? name[..80] + "…)" : name;
        return host.Length > 0 ? $"BookReader ({(host.Length > 60 ? host[..60] : host)})" : "BookReader";
    }

    static async Task<bool> TcpOpenAsync(IPAddress ip, int port, int timeoutMs, CancellationToken ct)
    {
        using var s = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeoutMs);
        try { await s.ConnectAsync(ip, port, cts.Token); return true; }
        catch { return false; }
    }

    static async Task<Found?> PingAsync(HttpClient http, IPAddress ip, int port, CancellationToken ct)
    {
        try
        {
            var json = await http.GetStringAsync($"http://{ip}:{port}/api/ping", ct);
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            if (Str(r, "name") != "BookReader") return null;
            return new Found(ip.ToString(), port, NameOf("", Str(r, "host")), Str(r, "version"), Str(r, "id"));
        }
        catch { return null; }
    }
}
