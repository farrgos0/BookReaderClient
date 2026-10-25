using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace BookReaderClient.Services;

/// <summary>Инструменты разработчика для экрана подключения: ping, TCP-порт, адреса устройства.</summary>
public static class NetTools
{
    /// <summary>ICMP ping. На части Android-устройств ICMP без root недоступен — тогда честно об этом пишем.</summary>
    public static async IAsyncEnumerable<string> PingAsync(string host, int count = 4)
    {
        if (string.IsNullOrWhiteSpace(host)) { yield return "адрес не указан"; yield break; }
        using var ping = new Ping();
        int ok = 0;
        var times = new List<long>();
        for (var i = 1; i <= count; i++)
        {
            string line;
            Exception? error = null;
            try
            {
                var r = await ping.SendPingAsync(host, 2000);
                if (r.Status == IPStatus.Success)
                {
                    ok++;
                    times.Add(r.RoundtripTime);
                    line = $"ответ от {r.Address}: время={r.RoundtripTime} мс";
                }
                else line = $"#{i}: {StatusText(r.Status)}";
            }
            catch (Exception ex)
            {
                error = ex;
                line = "";
            }
            // yield нельзя внутри catch — сообщаем об ошибке здесь
            if (error != null)
            {
                yield return $"ICMP недоступен: {(error.InnerException ?? error).Message}";
                yield return "подсказка: на Android ICMP иногда запрещён — используйте «TCP-порт» и «HTTP /api/ping»";
                yield break;
            }
            yield return line;
            if (i < count) await Task.Delay(400);
        }
        yield return times.Count > 0
            ? $"итог: {ok}/{count} ответов, мин/сред/макс = {times.Min()}/{(long)times.Average()}/{times.Max()} мс"
            : $"итог: 0/{count} ответов";
    }

    static string StatusText(IPStatus s) => s switch
    {
        IPStatus.TimedOut => "превышено время ожидания",
        IPStatus.DestinationHostUnreachable => "узел недоступен",
        IPStatus.DestinationNetworkUnreachable => "сеть недоступна",
        _ => s.ToString(),
    };

    /// <summary>Открыт ли TCP-порт (слушает ли сервер).</summary>
    public static async Task<string> TcpCheckAsync(string host, int port)
    {
        if (string.IsNullOrWhiteSpace(host)) return "адрес не указан";
        using var client = new TcpClient();
        var sw = Stopwatch.StartNew();
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            await client.ConnectAsync(host, port, cts.Token);
            return $"TCP {host}:{port} — порт открыт, {sw.ElapsedMilliseconds} мс";
        }
        catch (OperationCanceledException)
        {
            return $"TCP {host}:{port} — нет ответа за 3 с (ПК выключен, другая сеть или брандмауэр)";
        }
        catch (SocketException ex)
        {
            return ex.SocketErrorCode switch
            {
                SocketError.ConnectionRefused => $"TCP {host}:{port} — отказ: ПК доступен, но сервер не запущен на этом порту",
                SocketError.HostNotFound => $"TCP {host}:{port} — имя не найдено",
                _ => $"TCP {host}:{port} — {ex.SocketErrorCode}: {ex.Message}",
            };
        }
    }

    /// <summary>IPv4-адреса этого устройства — чтобы сравнить подсеть с адресом ПК.</summary>
    public static IEnumerable<string> LocalAddresses()
    {
        var list = new List<string>();
        try
        {
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up) continue;
                foreach (var a in ni.GetIPProperties().UnicastAddresses)
                {
                    if (a.Address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(a.Address)) continue;
                    list.Add($"{a.Address}  ({ni.Name})");
                }
            }
        }
        catch (Exception ex)
        {
            list.Add("не удалось получить адреса: " + ex.Message);
        }
        if (list.Count == 0) list.Add("нет активных сетей");
        return list;
    }
}
