using System.Collections.Concurrent;
using Android.Media;
using Android.OS;

namespace BookReaderClient.Services;

/// <summary>
/// Звук на Android: один непрерывный AudioTrack. Фразы дописываются в поток заранее, поэтому
/// следующая начинает звучать сразу за предыдущей — без пересоздания плеера и переоткрытия
/// аудиоканала (что и давало паузы в 2+ секунды). Всем треком владеет один фоновый поток.
/// </summary>
public sealed class AndroidAudioOutput : IAudioOutput
{
    sealed record Item(Task<Wav.Pcm?> Pcm, int Tag);
    sealed record Mark(long Frame, int Tag);

    readonly ConcurrentQueue<Item> incoming = new();
    readonly object sync = new();
    Thread? worker;

    // желаемое состояние (меняется из любых потоков, применяется рабочим потоком)
    volatile bool wantPaused;
    volatile int stopGen;
    double rate = 1;
    volatile bool rateDirty = true;

    public event Action<int>? SegmentStarted;
    public event Action? Drained;

    public void Enqueue(string wavPath, int tag)
    {
        // декодирование Opus — в фоне, заранее (в потоке звука ждать его не придётся)
        var pcm = Task.Run(() =>
        {
            try { return Wav.Read(wavPath); }
            catch (Exception ex) { System.Diagnostics.Debug.WriteLine("decode: " + ex.Message); return null; }
        });
        incoming.Enqueue(new Item(pcm, tag));
        EnsureWorker();
        if (!wantPaused) MainThread.BeginInvokeOnMainThread(PlaybackService.EnsureRunning);
    }

    public void Pause() => wantPaused = true;

    public void Resume()
    {
        wantPaused = false;
        EnsureWorker();
        MainThread.BeginInvokeOnMainThread(PlaybackService.EnsureRunning);
    }

    public void Stop()
    {
        while (incoming.TryDequeue(out _)) { }
        wantPaused = false;
        stopGen++;
    }

    public void SetRate(double newRate)
    {
        rate = newRate;
        rateDirty = true;
    }

    void EnsureWorker()
    {
        lock (sync)
        {
            if (worker is { IsAlive: true }) return;
            worker = new Thread(Run) { IsBackground = true, Name = "tts-audio" };
            worker.Start();
        }
    }

    // ---------- рабочий поток ----------

    void Run()
    {
        try { global::Android.OS.Process.SetThreadPriority(global::Android.OS.ThreadPriority.UrgentAudio); } catch { }

        AudioTrack? track = null;
        int trackRate = 0, trackCh = 0, frameBytes = 2;
        long written = 0;                 // кадров записано в трек
        var marks = new Queue<Mark>();    // где в потоке начинается каждая фраза
        byte[]? cur = null; int curOff = 0;   // фраза, которая сейчас пишется в трек
        Item? pending = null;                  // следующая фраза (может ещё декодироваться)
        var seenGen = stopGen;
        var playingNow = false;
        var needDrain = false;
        var idleSince = System.Environment.TickCount64;
        PowerManager.WakeLock? wake = null;

        void Release()
        {
            if (track == null) return;
            try { track.Pause(); track.Flush(); } catch { }
            try { track.Release(); } catch { }
            track.Dispose();
            track = null;
            written = 0;
            marks.Clear();
            playingNow = false;
        }

        void Wake(bool on)
        {
            try
            {
                if (on && wake == null)
                {
                    var pm = (PowerManager?)global::Android.App.Application.Context.GetSystemService(global::Android.Content.Context.PowerService);
                    wake = pm?.NewWakeLock(WakeLockFlags.Partial, "BookReader:tts");
                    wake?.Acquire();
                }
                else if (!on && wake != null)
                {
                    if (wake.IsHeld) wake.Release();
                    wake.Dispose();
                    wake = null;
                }
            }
            catch { }
        }

        AudioTrack Create(int sampleRate, int channels)
        {
            var mask = channels == 2 ? ChannelOut.Stereo : ChannelOut.Mono;
            var min = AudioTrack.GetMinBufferSize(sampleRate, mask, global::Android.Media.Encoding.Pcm16bit);
            var size = Math.Max(min * 4, sampleRate * channels * 2 / 2); // ~0,5 с буфера
            var t = new AudioTrack.Builder()
                .SetAudioAttributes(new AudioAttributes.Builder()
                    .SetUsage(AudioUsageKind.Media)!
                    .SetContentType(AudioContentType.Speech)!
                    .Build()!)!
                .SetAudioFormat(new AudioFormat.Builder()
                    .SetEncoding(global::Android.Media.Encoding.Pcm16bit)!
                    .SetSampleRate(sampleRate)!
                    .SetChannelMask(mask)!
                    .Build()!)!
                .SetTransferMode(AudioTrackMode.Stream)!
                .SetBufferSizeInBytes(size)!
                .Build()!;
            rateDirty = true;
            return t;
        }

        try
        {
            while (true)
            {
                // Стоп: выбросить всё
                if (seenGen != stopGen)
                {
                    seenGen = stopGen;
                    cur = null;
                    pending = null;
                    Release();
                    needDrain = false;
                }

                // взять следующую фразу
                if (cur == null && pending == null && incoming.TryDequeue(out var item)) pending = item;
                if (cur == null && pending != null && pending.Pcm.IsCompleted)
                {
                    var tag = pending.Tag;
                    var next = pending.Pcm.Result;
                    pending = null;
                    if (seenGen != stopGen) continue;
                    if (next == null || next.Data.Length == 0)
                    {
                        // не удалось прочитать — пропускаем фразу, но отмечаем её начало
                        marks.Enqueue(new Mark(written, tag));
                        needDrain = true;
                        continue;
                    }
                    if (track != null && (next.SampleRate != trackRate || next.Channels != trackCh))
                    {
                        // другой формат: дождаться, пока доиграет текущее, и пересоздать трек
                        while (track != null && track.PlaybackHeadPosition < written && seenGen == stopGen) Thread.Sleep(10);
                        Release();
                    }
                    if (track == null)
                    {
                        trackRate = next.SampleRate; trackCh = next.Channels; frameBytes = 2 * trackCh;
                        track = Create(trackRate, trackCh);
                    }
                    cur = next.Data; curOff = 0;
                    marks.Enqueue(new Mark(written, tag));
                    needDrain = true;
                }

                if (track != null)
                {
                    if (rateDirty)
                    {
                        rateDirty = false;
                        try
                        {
                            var p = new PlaybackParams();
                            p.SetSpeed((float)rate);
                            p.SetPitch(1f); // скорость без изменения тембра
                            track.PlaybackParams = p;
                        }
                        catch (Exception ex) { System.Diagnostics.Debug.WriteLine("PlaybackParams: " + ex.Message); }
                    }

                    if (wantPaused && playingNow) { track.Pause(); playingNow = false; Wake(false); }
                    else if (!wantPaused && !playingNow && (cur != null || track.PlaybackHeadPosition < written))
                    {
                        track.Play(); playingNow = true; Wake(true);
                    }

                    // дописать, сколько влезает (без блокировки — поток должен реагировать на команды)
                    if (cur != null)
                    {
                        var n = track.Write(cur, curOff, cur.Length - curOff, WriteMode.NonBlocking);
                        if (n > 0)
                        {
                            curOff += n;
                            written += n / frameBytes;
                        }
                        if (curOff >= cur.Length) cur = null;
                    }

                    // какая фраза сейчас звучит
                    long head = track.PlaybackHeadPosition;
                    while (marks.Count > 0 && head >= marks.Peek().Frame && (marks.Count > 1 || head > marks.Peek().Frame || written > marks.Peek().Frame))
                    {
                        var m = marks.Dequeue();
                        var g = seenGen;
                        MainThread.BeginInvokeOnMainThread(() => { if (g == stopGen) SegmentStarted?.Invoke(m.Tag); });
                    }

                    // всё доиграно
                    if (needDrain && cur == null && pending == null && incoming.IsEmpty && head >= written && playingNow)
                    {
                        needDrain = false;
                        var g = seenGen;
                        MainThread.BeginInvokeOnMainThread(() => { if (g == stopGen) Drained?.Invoke(); });
                    }
                }

                var busy = cur != null || pending != null || !incoming.IsEmpty || needDrain;
                if (busy || wantPaused) idleSince = System.Environment.TickCount64;
                else if (System.Environment.TickCount64 - idleSince > 30000) break; // давно тихо — отпускаем трек и поток

                Thread.Sleep(cur != null ? 5 : 15);
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine("AudioTrack: " + ex);
        }
        finally
        {
            Release();
            Wake(false);
            lock (sync) worker = null;
            if (!incoming.IsEmpty) EnsureWorker();
        }
    }
}
