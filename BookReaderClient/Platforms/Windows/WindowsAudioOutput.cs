using Windows.Media.Core;
using Windows.Media.Playback;

namespace BookReaderClient.Services;

/// <summary>Звук на Windows: MediaPlayer + MediaPlaybackList (следующая фраза заранее загружена, без пауз).</summary>
public sealed class WindowsAudioOutput : IAudioOutput
{
    readonly MediaPlayer player = new();
    MediaPlaybackList list = new();
    double rate = 1;
    bool paused;
    bool ended = true;
    int gen;

    public event Action<int>? SegmentStarted;
    public event Action? Drained;

    public WindowsAudioOutput()
    {
        player.CommandManager.IsEnabled = false;
        player.MediaEnded += (_, _) => { var g = gen; ended = true; MainThread.BeginInvokeOnMainThread(() => { if (g == gen) Drained?.Invoke(); }); };
        player.MediaFailed += (_, e) => System.Diagnostics.Debug.WriteLine("MediaFailed: " + e.ErrorMessage);
        NewList();
    }

    void NewList()
    {
        list = new MediaPlaybackList { AutoRepeatEnabled = false, MaxPrefetchTime = TimeSpan.FromSeconds(10) };
        var g = gen;
        list.CurrentItemChanged += (s, e) =>
        {
            if (e.NewItem?.Source.CustomProperties.TryGetValue("tag", out var t) == true && t is int tag)
                MainThread.BeginInvokeOnMainThread(() =>
                {
                    if (g != gen) return;
                    try { player.PlaybackSession.PlaybackRate = rate; } catch { }
                    SegmentStarted?.Invoke(tag);
                });
        };
        player.Source = list;
    }

    public void Enqueue(string wavPath, int tag)
    {
        var src = MediaSource.CreateFromUri(new Uri(Playable(wavPath)));
        src.CustomProperties["tag"] = tag;
        var item = new MediaPlaybackItem(src);
        if (ended)
        {
            // список доигран (или пуст) — начинаем новый с этой фразы
            gen++;
            NewList();
            list.Items.Add(item);
            ended = false;
            if (!paused) player.Play();
        }
        else list.Items.Add(item);
    }

    /// <summary>Ogg Opus Windows сам не играет — раскладываем в WAV рядом (во временную папку).</summary>
    static string Playable(string path)
    {
        using (var f = File.OpenRead(path))
        {
            var sig = new byte[4];
            if (f.Read(sig, 0, 4) == 4 && sig[0] == 'R' && sig[1] == 'I' && sig[2] == 'F' && sig[3] == 'F') return path;
        }
        var pcm = Wav.Read(path);
        var dir = Path.Combine(FileSystem.CacheDirectory, "play");
        Directory.CreateDirectory(dir);
        var outPath = Path.Combine(dir, Guid.NewGuid().ToString("N") + ".wav");
        using var w = new BinaryWriter(File.Create(outPath));
        var blockAlign = (short)(2 * pcm.Channels);
        w.Write("RIFF"u8); w.Write(36 + pcm.Data.Length); w.Write("WAVE"u8);
        w.Write("fmt "u8); w.Write(16); w.Write((short)1); w.Write((short)pcm.Channels);
        w.Write(pcm.SampleRate); w.Write(pcm.SampleRate * blockAlign); w.Write(blockAlign); w.Write((short)16);
        w.Write("data"u8); w.Write(pcm.Data.Length); w.Write(pcm.Data);
        return outPath;
    }
    static void CleanupPlayable()
    {
        try { foreach (var f in Directory.GetFiles(Path.Combine(FileSystem.CacheDirectory, "play"))) try { File.Delete(f); } catch { } }
        catch { }
    }

    public void Pause() { paused = true; player.Pause(); }

    public void Resume()
    {
        paused = false;
        if (!ended) player.Play();
    }

    public void Stop()
    {
        gen++;
        paused = false;
        ended = true;
        player.Pause();
        player.Source = null;
        CleanupPlayable();
    }

    public void SetRate(double newRate)
    {
        rate = newRate;
        try { player.PlaybackSession.PlaybackRate = rate; } catch { }
    }
}
