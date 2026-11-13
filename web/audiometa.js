/* Аудиокниги: разбор файлов без сторонних библиотек.
   Читает теги (название, автор, альбом), обложку, длительность и главы:
   MP3 (ID3v2.2–2.4, ID3v1, главы CHAP, длительность по Xing/VBRI или битрейту), M4B/M4A/MP4 (ilst, главы Nero chpl
   и QuickTime), OGG Vorbis/Opus (Vorbis comment, главы CHAPTERnnn), FLAC (VORBIS_COMMENT, PICTURE), WAV (RIFF INFO).
   Файл читается кусками через reader { size, read(off, len) → Promise<Uint8Array> }: в приложении — через мост,
   в браузере — Blob.slice; книги в сотни мегабайт целиком в память не грузятся.
   Книга из нескольких файлов — ZIP без сжатия (как сборники обычных книг): части по именам «по-человечески». */
(function () {
  "use strict";

  const AUDIO_EXT = ["mp3", "m4b", "m4a", "mp4", "ogg", "oga", "opus", "flac", "wav"];
  const ext = (name) => (String(name).match(/\.([^./\\]+)$/) || ["", ""])[1].toLowerCase();
  const isAudioName = (name) => AUDIO_EXT.includes(ext(name));
  const natCompare = new Intl.Collator("ru", { numeric: true, sensitivity: "base" }).compare;
  const MIME = { mp3: "audio/mpeg", m4b: "audio/mp4", m4a: "audio/mp4", mp4: "audio/mp4",
    ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", wav: "audio/wav" };
  const mimeOf = (name) => MIME[ext(name)] || "application/octet-stream";

  // ---------- чтение ----------
  function blobReader(blob) {
    return { size: blob.size, read: async (off, len) => new Uint8Array(await blob.slice(off, Math.min(blob.size, off + len)).arrayBuffer()) };
  }
  function bytesReader(u8) {
    return { size: u8.length, read: async (off, len) => u8.subarray(off, Math.min(u8.length, off + len)) };
  }
  // чтение блоками по 64 КБ с запоминанием: мелкие чтения заголовков не ходят через мост по одному
  function cachedReader(r, block = 64 * 1024, keep = 48) {
    const cache = new Map();
    const getBlock = (n) => {
      let p = cache.get(n);
      if (!p) {
        p = r.read(n * block, Math.min(block, r.size - n * block));
        cache.set(n, p);
        p.catch(() => cache.delete(n));
        if (cache.size > keep) cache.delete(cache.keys().next().value);
      }
      return p;
    };
    return {
      size: r.size,
      async read(off, len) {
        len = Math.max(0, Math.min(len, r.size - off));
        if (len > block * 4) return r.read(off, len);
        const a = Math.floor(off / block), b = Math.floor((off + len - 1) / block);
        if (len === 0) return new Uint8Array(0);
        const blocks = await Promise.all(Array.from({ length: b - a + 1 }, (_, k) => getBlock(a + k)));
        const out = new Uint8Array(len);
        let w = 0;
        for (let k = 0; k < blocks.length; k++) {
          const start = k === 0 ? off - a * block : 0;
          const piece = blocks[k].subarray(start, Math.min(blocks[k].length, start + (len - w)));
          out.set(piece, w);
          w += piece.length;
        }
        return w === len ? out : out.subarray(0, w);
      },
    };
  }
  // часть файла (запись ZIP без сжатия) как отдельный файл
  function subReader(r, base, size) {
    return { size, read: (off, len) => r.read(base + off, Math.max(0, Math.min(len, size - off))) };
  }

  const be16 = (b, o) => (b[o] << 8) | b[o + 1];
  const be24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
  const be32 = (b, o) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  const le16 = (b, o) => b[o] | (b[o + 1] << 8);
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
  const be64 = (b, o) => be32(b, o) * 0x100000000 + be32(b, o + 4);
  const le64 = (b, o) => le32(b, o) + le32(b, o + 4) * 0x100000000;
  const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

  // ---------- текст ----------
  const dec = (label) => { try { return new TextDecoder(label); } catch (_) { return new TextDecoder("utf-8"); } };
  const utf8 = dec("utf-8"), cp1251 = dec("windows-1251"), latin1 = dec("iso-8859-1");
  const clean = (s) => String(s || "").replace(/\0+$/g, "").replace(/\0/g, " ").trim();
  // «latin1» в русских MP3 почти всегда на деле cp1251: верхние байты без управляющих 0x80–0xBF → кириллица
  function legacyText(b) {
    let hi = 0, ctrl = 0;
    for (const c of b) { if (c >= 0x80) { hi++; if (c < 0xa0 && c !== 0x96 && c !== 0x97 && c !== 0x85) ctrl++; } }
    if (!hi) return latin1.decode(b);
    try { const s = new TextDecoder("utf-8", { fatal: true }).decode(b); return s; } catch (_) {}
    return ctrl * 4 > hi ? latin1.decode(b) : cp1251.decode(b);
  }
  function utf16(b, bigEndian) {
    let o = 0, be = bigEndian;
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) { be = false; o = 2; }
    else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) { be = true; o = 2; }
    let s = "";
    for (; o + 1 < b.length; o += 2) s += String.fromCharCode(be ? (b[o] << 8) | b[o + 1] : b[o] | (b[o + 1] << 8));
    return s;
  }
  function id3Text(enc, b) {
    if (enc === 1) return utf16(b, false);
    if (enc === 2) return utf16(b, true);
    if (enc === 3) return utf8.decode(b);
    return legacyText(b);
  }
  // конец строки с нулём в нужной кодировке (1 или 2 байта)
  function zEnd(b, o, enc) {
    if (enc === 1 || enc === 2) { for (let i = o; i + 1 < b.length; i += 2) if (!b[i] && !b[i + 1]) return i; return b.length; }
    const i = b.indexOf(0, o);
    return i < 0 ? b.length : i;
  }
  const zLen = (enc) => (enc === 1 || enc === 2 ? 2 : 1);

  function sniffImage(b) {
    if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
    if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
    if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
    if (b[0] === 0x52 && b[8] === 0x57) return "image/webp";
    return null;
  }
  const picture = (mime, data) => (data && data.length > 16 ? { mime: sniffImage(data) || mime || "image/jpeg", data: data.slice() } : null);

  // ---------- ID3v2 ----------
  const synchsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
  const unsync = (b) => { const out = []; for (let i = 0; i < b.length; i++) { out.push(b[i]); if (b[i] === 0xff && b[i + 1] === 0) i++; } return Uint8Array.from(out); };

  function parseId3Frames(tag, ver, out, chapters) {
    const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
    let p = 0;
    while (p + hdr <= tag.length) {
      const id = ascii(tag, p, idLen);
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
      const size = ver === 2 ? be24(tag, p + 3) : ver === 4 ? synchsafe(tag, p + 4) : be32(tag, p + 4);
      const flags = ver === 2 ? 0 : be16(tag, p + 8);
      if (size <= 0 || p + hdr + size > tag.length) break;
      let f = tag.subarray(p + hdr, p + hdr + size);
      p += hdr + size;
      if (ver === 4) {
        if (flags & 0x0002) f = unsync(f);
        if (flags & 0x0001) f = f.subarray(4);            // длина данных
        if (flags & 0x000c) continue;                     // сжатие/шифрование — пропускаем
      } else if (ver === 3 && flags & 0x00c0) continue;
      handleId3Frame(id, f, ver, out, chapters);
    }
  }
  function textFrame(f) { return clean(id3Text(f[0], f.subarray(1)).split("\0")[0]); }
  function handleId3Frame(id, f, ver, out, chapters) {
    switch (id) {
      case "TIT2": case "TT2": out.title = out.title || textFrame(f); break;
      case "TPE1": case "TP1": out.artist = out.artist || textFrame(f); break;
      case "TPE2": case "TP2": out.albumArtist = out.albumArtist || textFrame(f); break;
      case "TALB": case "TAL": out.album = out.album || textFrame(f); break;
      case "TCOM": case "TCM": out.composer = out.composer || textFrame(f); break;
      case "TRCK": case "TRK": out.track = out.track || parseInt(textFrame(f), 10) || 0; break;
      case "TPOS": case "TPA": out.disc = out.disc || parseInt(textFrame(f), 10) || 0; break;
      case "TLEN": case "TLE": { const ms = parseInt(textFrame(f), 10); if (ms > 0) out.tlen = ms / 1000; break; }
      case "APIC": {
        if (out.cover && out.coverType === 3) break;
        const enc = f[0];
        const m = f.indexOf(0, 1);
        if (m < 0) break;
        const mime = latin1.decode(f.subarray(1, m));
        const type = f[m + 1];
        const d = zEnd(f, m + 2, enc) + zLen(enc);
        if (!out.cover || type === 3) { out.cover = picture(mime, f.subarray(d)); out.coverType = type; }
        break;
      }
      case "PIC": {
        if (out.cover) break;
        const enc = f[0], fmt = ascii(f, 1, 3).toLowerCase();
        const d = zEnd(f, 5, enc) + zLen(enc);
        out.cover = picture(fmt === "png" ? "image/png" : "image/jpeg", f.subarray(d));
        break;
      }
      case "CHAP": {
        const e = f.indexOf(0);
        if (e < 0 || e + 17 > f.length) break;
        const start = be32(f, e + 1) / 1000;
        const sub = {};
        parseId3Frames(f.subarray(e + 17), ver, sub, null);
        if (chapters) chapters.push({ title: sub.title || "", start });
        break;
      }
    }
  }
  // → { end: где кончается тег } (может быть несколько тегов подряд)
  async function readId3v2(r, out, chapters) {
    let off = 0;
    for (let guard = 0; guard < 4; guard++) {
      const h = await r.read(off, 10);
      if (h.length < 10 || ascii(h, 0, 3) !== "ID3") break;
      const ver = h[3], flags = h[5], size = synchsafe(h, 6);
      const total = 10 + size + (flags & 0x10 ? 10 : 0);
      if (ver >= 2 && ver <= 4 && size > 0 && size < 64 * 1024 * 1024) {
        let tag = await r.read(off + 10, size);
        if (ver < 4 && flags & 0x80) tag = unsync(tag);
        if (flags & 0x40 && ver === 3) tag = tag.subarray(4 + be32(tag, 0));
        else if (flags & 0x40 && ver === 4) tag = tag.subarray(synchsafe(tag, 0));
        parseId3Frames(tag, ver, out, chapters);
      }
      off += total;
    }
    return off;
  }
  async function readId3v1(r, out) {
    if (r.size < 128) return false;
    const t = await r.read(r.size - 128, 128);
    if (ascii(t, 0, 3) !== "TAG") return false;
    const f = (o, n) => clean(legacyText(t.subarray(o, o + n)));
    out.title = out.title || f(3, 30);
    out.artist = out.artist || f(33, 30);
    out.album = out.album || f(63, 30);
    return true;
  }

  // ---------- MP3: длительность ----------
  const BR = {
    "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  };
  const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  function mpegHeader(b, o) {
    if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
    const verBits = (b[o + 1] >> 3) & 3, layerBits = (b[o + 1] >> 1) & 3;
    const brIdx = b[o + 2] >> 4, srIdx = (b[o + 2] >> 2) & 3, pad = (b[o + 2] >> 1) & 1, mode = b[o + 3] >> 6;
    if (verBits === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
    const v1 = verBits === 3, layer = 4 - layerBits;
    const kbps = BR[(v1 ? "1-" : "2-") + (v1 ? layer : layer === 1 ? 1 : 2)][brIdx];
    const sr = SR[verBits][srIdx];
    const spf = layer === 1 ? 384 : layer === 3 && !v1 ? 576 : 1152;
    const len = layer === 1 ? Math.floor((12 * kbps * 1000) / sr + pad) * 4 : Math.floor(((spf / 8) * kbps * 1000) / sr) + pad;
    return { v1, layer, kbps, sr, spf, len, mono: mode === 3 };
  }
  async function mp3Duration(r, start, hasV1) {
    const end = r.size - (hasV1 ? 128 : 0);
    const b = await r.read(start, 64 * 1024);
    for (let i = 0; i + 4 < b.length; i++) {
      const h = mpegHeader(b, i);
      if (!h) continue;
      const nx = mpegHeader(b, i + h.len);
      if (i + h.len + 4 < b.length && !nx) continue;     // ложная синхронизация
      // Xing/Info (VBR): число кадров; VBRI (Fraunhofer)
      const side = h.v1 ? (h.mono ? 17 : 32) : h.mono ? 9 : 17;
      const x = i + 4 + side;
      const tagX = ascii(b, x, 4);
      if ((tagX === "Xing" || tagX === "Info") && b[x + 7] & 1) return (be32(b, x + 8) * h.spf) / h.sr;
      if (ascii(b, i + 36, 4) === "VBRI") return (be32(b, i + 36 + 14) * h.spf) / h.sr;
      return ((end - start - i) * 8) / (h.kbps * 1000);  // постоянный битрейт
    }
    return 0;
  }

  // ---------- MP4 / M4B ----------
  const CONTAINERS = new Set(["moov", "udta", "trak", "mdia", "minf", "stbl", "ilst", "tref", "edts", "dinf"]);
  // атомы верхнего уровня читаем по заголовкам (mdat пропускаем, не читая); moov — целиком
  async function readMp4(r, out) {
    let p = 0, moov = null;
    while (p + 8 <= r.size) {
      const h = await r.read(p, 16);
      if (h.length < 8) break;
      let size = be32(h, 0);
      const type = ascii(h, 4, 4);
      let hdr = 8;
      if (size === 1) { size = be64(h, 8); hdr = 16; } else if (size === 0) size = r.size - p;
      if (size < hdr) break;
      if (type === "moov") {
        if (size > 64 * 1024 * 1024) throw new Error("слишком большой заголовок MP4");
        moov = await r.read(p + hdr, size - hdr);
        break;
      }
      p += size;
    }
    if (!moov) throw new Error("в файле нет заголовка moov");
    const atoms = (b, from, to, fn) => {
      let q = from;
      while (q + 8 <= to) {
        let size = be32(b, q), hdr = 8;
        const type = ascii(b, q + 4, 4);
        if (size === 1) { size = be64(b, q + 8); hdr = 16; } else if (size === 0) size = to - q;
        if (size < hdr || q + size > to) break;
        fn(type, q + hdr, q + size);
        q += size;
      }
    };
    const traks = [];
    let timescale = 0, duration = 0, chpl = null;
    atoms(moov, 0, moov.length, function walk(type, s, e, parent) {
      if (type === "mvhd") {
        const v = moov[s];
        timescale = v === 1 ? be32(moov, s + 20) : be32(moov, s + 12);
        duration = v === 1 ? be64(moov, s + 24) : be32(moov, s + 16);
      } else if (type === "trak") {
        const t = { s, e };
        traks.push(t);
        atoms(moov, s, e, function inTrak(ty, s2, e2) {
          if (ty === "tkhd") t.id = moov[s2] === 1 ? be32(moov, s2 + 20) : be32(moov, s2 + 12);
          else if (ty === "chap") { t.chapRefs = []; for (let k = s2; k + 4 <= e2; k += 4) t.chapRefs.push(be32(moov, k)); }
          else if (ty === "mdhd") t.scale = moov[s2] === 1 ? be32(moov, s2 + 20) : be32(moov, s2 + 12);
          else if (ty === "hdlr") t.handler = ascii(moov, s2 + 8, 4);
          else if (ty === "stts") { t.stts = []; for (let k = 0, n = be32(moov, s2 + 4); k < n; k++) t.stts.push([be32(moov, s2 + 8 + k * 8), be32(moov, s2 + 12 + k * 8)]); }
          else if (ty === "stsz") { const fixed = be32(moov, s2 + 4), n = be32(moov, s2 + 8); t.stsz = []; for (let k = 0; k < n; k++) t.stsz.push(fixed || be32(moov, s2 + 12 + k * 4)); }
          else if (ty === "stco") { t.stco = []; for (let k = 0, n = be32(moov, s2 + 4); k < n; k++) t.stco.push(be32(moov, s2 + 8 + k * 4)); }
          else if (ty === "co64") { t.stco = []; for (let k = 0, n = be32(moov, s2 + 4); k < n; k++) t.stco.push(be64(moov, s2 + 8 + k * 8)); }
          else if (ty === "stsc") { t.stsc = []; for (let k = 0, n = be32(moov, s2 + 4); k < n; k++) t.stsc.push([be32(moov, s2 + 8 + k * 12), be32(moov, s2 + 12 + k * 12)]); }
          else if (CONTAINERS.has(ty) || ty === "stsd") { if (ty !== "stsd") atoms(moov, s2, e2, inTrak); }
        });
      } else if (type === "meta") {
        atoms(moov, s + 4, e, walk);                       // у meta есть 4 байта версии/флагов
      } else if (type === "chpl") {
        const v = moov[s];
        let q = s + 4 + (v === 1 ? 5 : 1);                 // версия, флаги, (резерв), число глав
        const n = moov[q - 1];
        chpl = [];
        for (let k = 0; k < n && q + 9 <= e; k++) {
          const start = be64(moov, q) / 1e7, len = moov[q + 8];
          chpl.push({ title: clean(utf8.decode(moov.subarray(q + 9, q + 9 + len))), start });
          q += 9 + len;
        }
      } else if (parent === "ilst" || /^(\xa9nam|\xa9ART|aART|\xa9alb|covr|\xa9wrt|trkn)$/.test(type)) {
        // элемент ilst: внутри атом data (тип, локаль, значение)
        atoms(moov, s, e, (ty, s2, e2) => {
          if (ty !== "data") return;
          const kind = be32(moov, s2) & 0xffffff, val = moov.subarray(s2 + 8, e2);
          const txt = () => clean(utf8.decode(val));
          if (type === "\xa9nam") out.title = out.title || txt();
          else if (type === "\xa9ART") out.artist = out.artist || txt();
          else if (type === "aART") out.albumArtist = out.albumArtist || txt();
          else if (type === "\xa9alb") out.album = out.album || txt();
          else if (type === "\xa9wrt") out.composer = out.composer || txt();
          else if (type === "trkn" && val.length >= 4) out.track = out.track || be16(val, 2);
          else if (type === "covr" && !out.cover) out.cover = picture(kind === 14 ? "image/png" : "image/jpeg", val);
        });
      } else if (CONTAINERS.has(type)) {
        atoms(moov, s, e, (t2, s2, e2) => walk(t2, s2, e2, type));
      }
    });
    out.duration = timescale ? duration / timescale : 0;
    // главы QuickTime: дорожка текста, на которую ссылается tref/chap; иначе Nero chpl
    let chapters = null;
    const ref = traks.find((t) => t.chapRefs && t.chapRefs.length);
    const txt = ref && traks.find((t) => t.id === ref.chapRefs[0] && t.stsz && t.stco && t.stts);
    if (txt) {
      try { chapters = await qtChapters(r, txt); } catch (_) { chapters = null; }
    }
    if ((!chapters || !chapters.length) && chpl && chpl.length) chapters = chpl;
    return chapters || [];
  }
  async function qtChapters(r, t) {
    // смещения образцов: по таблице «фрагмент → сколько образцов» (stsc)
    const offs = [];
    let si = 0;
    for (let c = 0; c < t.stco.length; c++) {
      let per = 1;
      for (const [first, n] of t.stsc || [[1, 1]]) if (c + 1 >= first) per = n;
      let o = t.stco[c];
      for (let k = 0; k < per && si < t.stsz.length; k++, si++) { offs.push(o); o += t.stsz[si]; }
    }
    const res = [];
    let time = 0, sample = 0;
    for (const [count, delta] of t.stts) {
      for (let k = 0; k < count && sample < offs.length; k++, sample++) {
        const b = await r.read(offs[sample], Math.min(t.stsz[sample], 1024));
        const len = be16(b, 0);
        let title = "";
        if (len > 0 && b.length >= 2 + len) {
          const raw = b.subarray(2, 2 + len);
          title = raw[0] === 0xfe && raw[1] === 0xff ? utf16(raw, true) : utf8.decode(raw);
        }
        res.push({ title: clean(title), start: time / (t.scale || 1000) });
        time += delta;
      }
    }
    return res;
  }

  // ---------- Vorbis comment (OGG, FLAC) ----------
  function vorbisComments(b, o, out, chapters) {
    const vlen = le32(b, o);
    o += 4 + vlen;
    const n = le32(b, o);
    o += 4;
    const map = {};
    for (let k = 0; k < n && o + 4 <= b.length; k++) {
      const len = le32(b, o);
      const s = utf8.decode(b.subarray(o + 4, o + 4 + len));
      o += 4 + len;
      const eq = s.indexOf("=");
      if (eq <= 0) continue;
      const key = s.slice(0, eq).toUpperCase(), val = s.slice(eq + 1);
      if (key === "METADATA_BLOCK_PICTURE") {
        if (!out.cover) try { out.cover = flacPicture(Uint8Array.from(atob(val.replace(/\s+/g, "")), (c) => c.charCodeAt(0)), 0); } catch (_) {}
      } else (map[key] = map[key] || []).push(val);
    }
    const g = (k) => clean((map[k] || [])[0]);
    out.title = out.title || g("TITLE");
    out.artist = out.artist || g("ARTIST") || g("AUTHOR") || g("PERFORMER");
    out.albumArtist = out.albumArtist || g("ALBUMARTIST");
    out.album = out.album || g("ALBUM");
    out.track = out.track || parseInt(g("TRACKNUMBER"), 10) || 0;
    if (chapters) {
      for (let k = 0; k < 1000; k++) {
        const id = "CHAPTER" + String(k).padStart(3, "0");
        if (!map[id]) { if (k > 1) break; continue; }      // нумерация с 000 или с 001
        const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(map[id][0]);
        if (m) chapters.push({ title: clean((map[id + "NAME"] || [""])[0]), start: +m[1] * 3600 + +m[2] * 60 + +m[3] });
      }
    }
  }
  function flacPicture(b, o) {
    const mlen = be32(b, o + 4);
    const mime = latin1.decode(b.subarray(o + 8, o + 8 + mlen));
    let q = o + 8 + mlen;
    q += 4 + be32(b, q);                 // описание
    q += 16;                             // размеры, глубина, палитра
    const len = be32(b, q);
    return picture(mime, b.subarray(q + 4, q + 4 + len));
  }

  // ---------- OGG ----------
  async function readOgg(r, out, chapters) {
    // пакеты заголовка: собираем из страниц, пока не будет 2 (Opus) / 3 (Vorbis) пакетов; обложка бывает большой
    const packets = [];
    let cur = [], p = 0, codec = "", serial = -1;
    const MAX = 16 * 1024 * 1024;
    while (p < Math.min(r.size, MAX) && packets.length < 2) {
      const h = await r.read(p, 27 + 255);
      if (ascii(h, 0, 4) !== "OggS") break;
      const ser = le32(h, 14), nseg = h[26];
      const lacing = h.subarray(27, 27 + nseg);
      const bodyLen = lacing.reduce((a, c) => a + c, 0);
      const body = await r.read(p + 27 + nseg, bodyLen);
      p += 27 + nseg + bodyLen;
      if (serial < 0) serial = ser;
      if (ser !== serial) continue;
      let q = 0;
      for (const l of lacing) {
        cur.push(body.subarray(q, q + l));
        q += l;
        if (l < 255) {
          const len = cur.reduce((a, c) => a + c.length, 0), pk = new Uint8Array(len);
          let w = 0;
          for (const c of cur) { pk.set(c, w); w += c.length; }
          packets.push(pk);
          cur = [];
        }
      }
    }
    if (!packets.length) throw new Error("повреждённый файл OGG");
    const id = packets[0];
    let rate = 0, preskip = 0;
    if (ascii(id, 0, 8) === "OpusHead") { codec = "opus"; rate = 48000; preskip = le16(id, 10); }
    else if (ascii(id, 1, 6) === "vorbis") { codec = "vorbis"; rate = le32(id, 12); }
    else throw new Error("неизвестный кодек в OGG");
    const c = packets[1];
    if (c) {
      if (codec === "opus" && ascii(c, 0, 8) === "OpusTags") vorbisComments(c, 8, out, chapters);
      else if (codec === "vorbis" && ascii(c, 1, 6) === "vorbis") vorbisComments(c, 7, out, chapters);
    }
    // длительность: позиция (granule) последней страницы
    const tailLen = Math.min(r.size, 128 * 1024);
    const tail = await r.read(r.size - tailLen, tailLen);
    for (let i = tail.length - 27; i >= 0; i--) {
      if (tail[i] === 0x4f && ascii(tail, i, 4) === "OggS" && le32(tail, i + 14) === serial) {
        const g = le64(tail, i + 6);
        if (g > 0 && g < 2 ** 52) { out.duration = Math.max(0, (g - preskip) / rate); break; }
      }
    }
    out.codec = codec;
  }

  // ---------- FLAC ----------
  async function readFlac(r, out, chapters, start) {
    let p = start + 4, last = false;
    while (!last && p + 4 <= r.size) {
      const h = await r.read(p, 4);
      last = !!(h[0] & 0x80);
      const type = h[0] & 0x7f, len = be24(h, 1);
      if (type === 0 || type === 4 || type === 6) {
        const b = await r.read(p + 4, len);
        if (type === 0) {
          const sr = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
          const total = (b[13] & 0x0f) * 0x100000000 + be32(b, 14);
          if (sr) out.duration = total / sr;
        } else if (type === 4) vorbisComments(b, 0, out, chapters);
        else if (!out.cover) out.cover = flacPicture(b, 0);
      }
      p += 4 + len;
    }
  }

  // ---------- WAV ----------
  async function readWav(r, out) {
    const h = await r.read(0, 12);
    if (ascii(h, 0, 4) !== "RIFF" || ascii(h, 8, 4) !== "WAVE") throw new Error("повреждённый файл WAV");
    let p = 12, byteRate = 0, dataLen = 0;
    while (p + 8 <= r.size) {
      const c = await r.read(p, 8);
      const id = ascii(c, 0, 4), len = le32(c, 4);
      if (id === "fmt ") { const f = await r.read(p + 8, 16); byteRate = le32(f, 8); }
      else if (id === "data") dataLen = Math.min(len, r.size - p - 8);
      else if (id === "LIST" && len < 1024 * 1024) {
        const b = await r.read(p + 8, len);
        if (ascii(b, 0, 4) === "INFO") {
          for (let q = 4; q + 8 <= b.length;) {
            const k = ascii(b, q, 4), l = le32(b, q + 4), v = clean(legacyText(b.subarray(q + 8, q + 8 + l)));
            if (k === "INAM") out.title = out.title || v;
            else if (k === "IART") out.artist = out.artist || v;
            else if (k === "IPRD") out.album = out.album || v;
            q += 8 + l + (l & 1);
          }
        }
      }
      p += 8 + len + (len & 1);
    }
    out.duration = byteRate ? dataLen / byteRate : 0;
  }

  // ---------- один файл ----------
  // → { format, title, artist, album, cover: {mime, data} | null, duration (с), chapters: [{title, start}] }
  async function readFile(r, name) {
    const out = { title: "", artist: "", album: "", cover: null, duration: 0 };
    const chapters = [];
    const head = await r.read(0, 12);
    const id3 = ascii(head, 0, 3) === "ID3";
    let fmt = "";
    if (!r.size) throw new Error("пустой файл");
    if (ascii(head, 4, 4) === "ftyp") {
      fmt = "mp4";
      chapters.push(...(await readMp4(r, out)));
    } else if (ascii(head, 0, 4) === "OggS") {
      fmt = "ogg";
      await readOgg(r, out, chapters);
    } else if (ascii(head, 0, 4) === "RIFF") {
      fmt = "wav";
      await readWav(r, out);
    } else {
      const start = id3 ? await readId3v2(r, out, chapters) : 0;
      const at = await r.read(start, 4);
      if (ascii(at, 0, 4) === "fLaC") { fmt = "flac"; await readFlac(r, out, chapters, start); }
      else {
        const v1 = await readId3v1(r, out);
        out.duration = (await mp3Duration(r, start, v1)) || out.tlen || 0;
        if (!out.duration) throw new Error("не похоже на аудиофайл");
        fmt = "mp3";
      }
    }
    chapters.sort((a, b) => a.start - b.start);
    const ch = chapters.filter((c) => c.start >= 0 && (!out.duration || c.start < out.duration + 1));
    return {
      format: fmt, title: out.title, artist: out.artist || out.albumArtist || out.composer || "", album: out.album,
      albumArtist: out.albumArtist || "", track: out.track || 0, cover: out.cover || null,
      duration: Math.max(0, out.duration || 0), chapters: ch, codec: out.codec || "", mime: mimeOf(name),
    };
  }

  // ---------- ZIP без сжатия (несколько файлов) ----------
  // → [{ name, method, off: начало данных, size, image }] — аудиофайлы и картинки (all — вообще все файлы, без смещений данных)
  async function zipEntries(r, all) {
    const tailLen = Math.min(r.size, 66000);
    const t = await r.read(r.size - tailLen, tailLen);
    let eocd = -1;
    for (let i = t.length - 22; i >= 0; i--) if (t[i] === 0x50 && le32(t, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("повреждённый ZIP-архив");
    let count = le16(t, eocd + 10), cdSize = le32(t, eocd + 12), cdOff = le32(t, eocd + 16);
    // ZIP64
    if (cdOff === 0xffffffff || count === 0xffff) {
      const loc = eocd - 20;
      if (loc >= 0 && le32(t, loc) === 0x07064b50) {
        const z = await r.read(le64(t, loc + 8), 56);
        count = le64(z, 32); cdSize = le64(z, 40); cdOff = le64(z, 48);
      }
    }
    const cd = await r.read(cdOff, cdSize);
    const names = new TextDecoder("utf-8");
    const res = [];
    for (let p = 0, n = 0; n < count && p + 46 <= cd.length; n++) {
      if (le32(cd, p) !== 0x02014b50) break;
      const method = le16(cd, p + 10);
      let csize = le32(cd, p + 20), off = le32(cd, p + 42);
      const nlen = le16(cd, p + 28), elen = le16(cd, p + 30), clen = le16(cd, p + 32);
      const flags = le16(cd, p + 8);
      const raw = cd.subarray(p + 46, p + 46 + nlen);
      const name = flags & 0x800 ? names.decode(raw) : legacyName(raw);
      // ZIP64: размеры и смещение — в доп. поле
      for (let q = p + 46 + nlen, end = q + elen; q + 4 <= end;) {
        const id = le16(cd, q), l = le16(cd, q + 2);
        if (id === 1) {
          let k = q + 4;
          if (le32(cd, p + 24) === 0xffffffff) k += 8;
          if (csize === 0xffffffff) { csize = le64(cd, k); k += 8; }
          if (off === 0xffffffff) off = le64(cd, k);
        }
        q += 4 + l;
      }
      p += 46 + nlen + elen + clen;
      if (name.endsWith("/") || /(^|\/)__MACOSX\//.test(name) || /(^|\/)\._/.test(name)) continue;
      const image = /\.(jpe?g|png|webp)$/i.test(name);
      if (!all && !image && !isAudioName(name)) continue;
      res.push({ name, method, off, size: csize, image });
    }
    if (all) return res;
    // смещение данных — после локального заголовка (его доп. поле может отличаться от центрального)
    for (const e of res) {
      const lh = await r.read(e.off, 30);
      e.off += 30 + le16(lh, 26) + le16(lh, 28);
    }
    return res.sort((a, b) => natCompare(a.name, b.name));
  }
  function legacyName(raw) { try { return new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch (_) { return dec("ibm866").decode(raw); } }

  // ---------- книга ----------
  const baseName = (n) => String(n).split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
  function prettyName(n) { return baseName(n).replace(/[_]+/g, " ").replace(/\s+/g, " ").trim(); }
  // общее начало имён частей → название книги («Книга - 01.mp3», «Книга - 02.mp3» → «Книга»)
  function commonTitle(names) {
    const base = names.map(baseName);
    let pre = base[0] || "";
    for (const b of base) while (pre && !b.startsWith(pre)) pre = pre.slice(0, -1);
    pre = pre.replace(/[\s\d._\-–—()[\]#№]+$/u, "").replace(/(глава|часть|chapter|part|гл|track|трек)$/iu, "").replace(/[\s._\-–—]+$/u, "");
    return pre.length >= 3 ? pre.replace(/_/g, " ").trim() : "";
  }

  /* Разобрать аудиокнигу: один файл или ZIP без сжатия.
     → { title, authors, cover, duration, parts: [{ name, off, size, duration, mime }], chapters: [{ title, part, start, at }] }
     at — время от начала книги, start — от начала части. */
  async function readBook(r, name, onProgress) {
    const zip = ext(name) === "zip" || (await r.read(0, 4)).every((c, i) => c === [0x50, 0x4b, 3, 4][i]);
    if (!zip) {
      const m = await readFile(r, name);
      const chapters = m.chapters.length ? m.chapters.map((c, i) => ({ title: c.title || `Глава ${i + 1}`, part: 0, start: c.start, at: c.start }))
        : [{ title: m.title || prettyName(name), part: 0, start: 0, at: 0 }];
      return {
        title: m.album || m.title || prettyName(name),
        authors: splitAuthors(m.artist), cover: m.cover, duration: m.duration,
        parts: [{ name, off: 0, size: r.size, duration: m.duration, mime: m.mime }], chapters, format: m.format,
      };
    }
    const all = await zipEntries(r);
    const entries = all.filter((e) => !e.image);
    if (!entries.length) throw new Error("в архиве нет аудиофайлов");
    if (entries.some((e) => e.method !== 0)) throw new Error("файлы в архиве сжаты");
    const parts = [], chapters = [];
    let at = 0, first = null, cover = null;
    for (const [i, e] of entries.entries()) {
      if (onProgress) onProgress(i, entries.length);
      let m;
      try { m = await readFile(subReader(r, e.off, e.size), e.name); }
      catch (err) { throw new Error(`«${baseName(e.name)}»: ${err.message}`); }
      if (!first) first = m;
      if (!cover && m.cover) cover = m.cover;
      parts.push({ name: e.name, off: e.off, size: e.size, duration: m.duration, mime: m.mime });
      if (m.chapters.length > 1) m.chapters.forEach((c, k) => chapters.push({ title: c.title || `${prettyName(e.name)} · ${k + 1}`, part: i, start: c.start, at: at + c.start }));
      else chapters.push({ title: (entries.length > 1 && m.title && m.title !== (first && first.album) ? m.title : "") || prettyName(e.name), part: i, start: 0, at });
      at += m.duration;
    }
    // обложки в тегах нет — картинка из архива (cover/folder/front/обложка — в первую очередь)
    if (!cover) {
      const imgs = all.filter((e) => e.image && e.method === 0 && e.size < 20 * 1024 * 1024);
      const pickImg = imgs.find((e) => /(^|\/)(cover|folder|front|обложка)[^/]*$/i.test(e.name)) || imgs[0];
      if (pickImg) cover = picture("image/jpeg", await r.read(pickImg.off, pickImg.size));
    }
    // папка внутри архива с именем книги — тоже подсказка
    const dir = (entries[0].name.match(/^(?:.*\/)?([^/]+)\/[^/]+$/) || [])[1];
    const title = first.album || commonTitle(entries.map((e) => e.name)) || dir || prettyName(name);
    return { title, authors: splitAuthors(first.artist || first.albumArtist), cover, duration: at, parts, chapters, format: "zip" };
  }
  function splitAuthors(s) {
    return String(s || "").split(/\s*(?:;|\/|,(?=\s*[A-ZА-ЯЁ]))\s*/u).map((x) => x.trim()).filter(Boolean).slice(0, 5);
  }

  // время для людей: 1:02:03 / 4:05
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  }
  function fmtDuration(sec) {
    sec = Math.round(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h} ч ${m} мин` : `${Math.max(1, m)} мин`;
  }

  // ZIP — аудиокнига? (есть аудиофайлы и нет файлов обычных книг; картинки, txt, pdf, cue — не мешают)
  const BOOK_EXT = /\.(fb2|epub|docx|odt|rtf|mobi|azw3?|prc|html?|xhtml|md)$/i;
  async function zipIsAudio(r) {
    try {
      const names = (await zipEntries(r, true)).map((e) => e.name);
      return names.some(isAudioName) && !names.some((n) => BOOK_EXT.test(n));
    } catch (_) { return false; }
  }
  // файл — аудиокнига? (по расширению; ZIP — по содержимому)
  async function isAudioBook(name, r) {
    if (isAudioName(name)) return true;
    if (ext(name) !== "zip" || !r) return false;
    return zipIsAudio(r);
  }
  // в архиве есть сжатые аудиофайлы — их надо переложить без сжатия, чтобы слушать прямо из файла
  async function zipNeedsRepack(r) {
    try { return (await zipEntries(r)).some((e) => !e.image && e.method !== 0); } catch (_) { return false; }
  }

  // ---------- сборка ZIP без сжатия (браузер) ----------
  // Части книги из отдельных файлов и/или архивов → один ZIP без сжатия (как сборники обычных книг):
  // его части можно слушать прямо из файла. Данные не копируются в память целиком: Blob из кусков исходных файлов.
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  async function crcOf(blob, onBytes) {
    let c = 0xffffffff;
    const STEP = 4 * 1024 * 1024;
    for (let o = 0; o < blob.size; o += STEP) {
      const b = new Uint8Array(await blob.slice(o, o + STEP).arrayBuffer());
      for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8);
      if (onBytes) onBytes(b.length);
    }
    return (c ^ 0xffffffff) >>> 0;
  }
  async function inflateBlob(blob) {
    if (typeof DecompressionStream === "undefined") throw new Error("браузер не умеет распаковывать ZIP");
    return new Response(blob.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
  }
  // files: File/Blob с .name → [{ name, blob }] — аудио и картинки; архивы раскрываются
  async function collectParts(files) {
    const out = [];
    const sorted = [...files].sort((a, b) => natCompare(a.name, b.name));
    for (const f of sorted) {
      if (ext(f.name) === "zip") {
        for (const e of await zipEntries(blobReader(f))) {
          // смещение данных уже посчитано; сжатый размер = size
          const raw = f.slice(e.off, e.off + e.size);
          out.push({ name: e.name, blob: e.method === 0 ? raw : e.method === 8 ? await inflateBlob(raw) : null });
        }
      } else if (isAudioName(f.name)) out.push({ name: f.name, blob: f });
    }
    if (out.some((p) => !p.blob)) throw new Error("неподдерживаемое сжатие в архиве");
    // одинаковые имена из разных архивов — не затираем
    const used = new Set();
    for (const p of out) {
      let nm = p.name, k = 2;
      while (used.has(nm.toLowerCase())) nm = p.name.replace(/(\.[^.]+)?$/, ` (${k++})$1`);
      used.add(nm.toLowerCase());
      p.name = nm;
    }
    return out;
  }
  // [{ name, blob }] → Blob (ZIP без сжатия); onProgress(доля 0..1)
  async function packZip(parts, onProgress) {
    const total = parts.reduce((a, p) => a + p.blob.size, 0) || 1;
    if (total > 4000 * 1024 * 1024) throw new Error("книга больше 4 ГБ — такие пока не поддерживаются");
    let done = 0;
    const enc = new TextEncoder(), chunks = [], central = [];
    let off = 0;
    for (const p of parts) {
      const nb = enc.encode(p.name);
      const crc = await crcOf(p.blob, (n) => { done += n; if (onProgress) onProgress(done / total); });
      const size = p.blob.size;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 10, true); h.setUint16(6, 0x800, true); h.setUint16(8, 0, true);
      h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, nb.length, true);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 10, true); c.setUint16(6, 10, true); c.setUint16(8, 0x800, true);
      c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
      chunks.push(h.buffer, nb, p.blob);
      central.push(c.buffer, nb);
      off += 30 + nb.length + size;
    }
    const cdSize = central.reduce((a, x) => a + x.byteLength, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, parts.length, true); e.setUint16(10, parts.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
    return new Blob([...chunks, ...central, e.buffer], { type: "application/zip" });
  }
  // название файла собранной книги
  function packName(names) { return (commonTitle(names) || `Аудиокнига из ${names.length} файлов`) + ".zip"; }

  const api = { cachedReader, isAudioName, collectParts, packZip, packName, isAudioBook, zipIsAudio, zipNeedsRepack, mimeOf, readFile, readBook, zipEntries, blobReader, bytesReader, subReader, fmtTime, fmtDuration, natCompare, ext };
  if (typeof window !== "undefined") window.AudioMeta = api;
  if (typeof module !== "undefined") module.exports = api;
})();
