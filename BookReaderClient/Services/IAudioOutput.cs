using System.Runtime.InteropServices;
using Concentus;

namespace BookReaderClient.Services;

/// <summary>
/// Бесшовный вывод звука: фрагменты ставятся в очередь заранее и звучат подряд без пауз
/// и без перезапуска плеера (на Android — один непрерывный AudioTrack).
/// </summary>
public interface IAudioOutput
{
    /// <summary>Начал звучать фрагмент с этой меткой.</summary>
    event Action<int>? SegmentStarted;

    /// <summary>Всё поставленное в очередь доиграно, новых данных нет.</summary>
    event Action? Drained;

    /// <summary>Поставить аудиофайл (Ogg Opus или WAV) в очередь на воспроизведение.</summary>
    void Enqueue(string path, int tag);

    void Pause();
    void Resume();

    /// <summary>Остановить и очистить очередь.</summary>
    void Stop();

    void SetRate(double rate);
}

/// <summary>
/// Чтение звука в PCM 16 бит: Ogg Opus (так сервер отдаёт приложению) или WAV.
/// Opus декодируется в C# (Concentus), Ogg разбирается вручную — без системных кодеков.
/// </summary>
public static class Wav
{
    public sealed record Pcm(byte[] Data, int SampleRate, int Channels);

    public static Pcm Read(string path)
    {
        var b = File.ReadAllBytes(path);
        if (b.Length >= 4 && b[0] == 'O' && b[1] == 'g' && b[2] == 'g' && b[3] == 'S') return ReadOggOpus(b);
        if (b.Length >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F') return ReadWav(b);
        throw new InvalidDataException("неизвестный формат звука");
    }

    static Pcm ReadWav(byte[] b)
    {
        int sampleRate = 48000, channels = 1;
        var pos = 12; // после "RIFF....WAVE"
        while (pos + 8 <= b.Length)
        {
            var id = System.Text.Encoding.ASCII.GetString(b, pos, 4);
            var size = BitConverter.ToInt32(b, pos + 4);
            var body = pos + 8;
            if (id == "fmt ")
            {
                channels = BitConverter.ToInt16(b, body + 2);
                sampleRate = BitConverter.ToInt32(b, body + 4);
            }
            else if (id == "data")
            {
                var len = Math.Min(size < 0 ? b.Length - body : size, b.Length - body);
                var data = new byte[len];
                Buffer.BlockCopy(b, body, data, 0, len);
                return new Pcm(data, sampleRate, channels);
            }
            pos = body + size + (size & 1);
        }
        throw new InvalidDataException("не удалось прочитать WAV");
    }

    static Pcm ReadOggOpus(byte[] b)
    {
        // 1) Ogg-страницы → пакеты Opus
        var packets = new List<byte[]>();
        var cur = new MemoryStream();
        long lastGranule = -1;
        var pos = 0;
        while (pos + 27 <= b.Length && b[pos] == 'O' && b[pos + 1] == 'g' && b[pos + 2] == 'g' && b[pos + 3] == 'S')
        {
            var granule = BitConverter.ToInt64(b, pos + 6);
            int nseg = b[pos + 26];
            var lacing = pos + 27;
            var data = lacing + nseg;
            if (data > b.Length) break;
            for (var i = 0; i < nseg; i++)
            {
                int len = b[lacing + i];
                if (data + len > b.Length) { len = b.Length - data; }
                cur.Write(b, data, len);
                data += len;
                if (b[lacing + i] < 255) { packets.Add(cur.ToArray()); cur.SetLength(0); }
            }
            if (granule >= 0) lastGranule = granule;
            pos = data;
        }
        if (packets.Count < 2 || packets[0].Length < 19 || System.Text.Encoding.ASCII.GetString(packets[0], 0, 8) != "OpusHead")
            throw new InvalidDataException("повреждённый файл Opus");

        int channels = Math.Max(1, (int)packets[0][9]);
        int preSkip = BitConverter.ToUInt16(packets[0], 10);

        // 2) пакеты → PCM 48 кГц
        var decoder = OpusCodecFactory.CreateDecoder(48000, channels);
        const int MaxFrame = 5760; // 120 мс при 48 кГц
        var frame = new short[MaxFrame * channels];
        var pcm = new List<short>(packets.Count * 960 * channels);
        for (var i = 2; i < packets.Count; i++) // 0 — OpusHead, 1 — OpusTags
        {
            if (packets[i].Length == 0) continue;
            var n = decoder.Decode(packets[i], frame, MaxFrame, false);
            if (n > 0) pcm.AddRange(new ArraySegment<short>(frame, 0, n * channels));
        }

        // 3) отрезать служебное начало (pre-skip) и добивку в конце (по granule последней страницы)
        var total = pcm.Count / channels;
        var start = Math.Min(preSkip, total);
        var end = total;
        if (lastGranule > 0) end = (int)Math.Clamp(lastGranule, start, total);
        var samples = CollectionsMarshal.AsSpan(pcm).Slice(start * channels, (end - start) * channels);
        return new Pcm(MemoryMarshal.AsBytes(samples).ToArray(), 48000, channels);
    }
}
