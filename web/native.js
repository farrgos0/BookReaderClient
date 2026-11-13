// Режим нативного клиента (BookReaderClient, MAUI HybridWebView).
// В обычном браузере этот файл ничего не делает.
// В приложении: библиотека — SQLite на устройстве, озвучка — нативный плеер (работает в фоне),
// запросы к серверу озвучки делает C#, адрес сервера — в настройках приложения.
(function () {
  "use strict";
  const H = window.HybridWebView;
  if (!H || typeof H.InvokeDotNet !== "function") return;
  document.documentElement.classList.add("native");

  // Транспорт. На Android мост кладёт аргументы в HTTP-заголовок, где допустима только латиница,
  // поэтому всё упаковываем: JSON → UTF-8 → base64 (и обратно для ответа). Большое — по частям.
  const utf8 = new TextEncoder(), unutf8 = new TextDecoder();
  const pack = (s) => toB64(utf8.encode(s));
  const unpack = (b) => unutf8.decode(fromB64(b));
  const PART = 48 * 1024;
  async function call(method, ...args) {
    const payload = pack(JSON.stringify(args.map((a) => (a === undefined || a === null ? null : String(a)))));
    let r;
    if (payload.length <= PART) r = await H.InvokeDotNet("Call", [method, payload]);
    else {
      const token = await H.InvokeDotNet("CallBegin", []);
      for (let i = 0; i < payload.length; i += PART) await H.InvokeDotNet("CallPart", [token, payload.slice(i, i + PART)]);
      r = await H.InvokeDotNet("CallEnd", [token, method]);
    }
    return r === null || r === undefined || r === "" ? null : unpack(r);
  }
  // ответ — уже латиница (base64 файла): без второй упаковки в base64, вдвое меньше данных и работы
  async function callRaw(method, ...args) {
    const payload = pack(JSON.stringify(args.map((a) => (a === undefined || a === null ? null : String(a)))));
    return (await H.InvokeDotNet("CallRaw", [method, payload])) || "";
  }
  async function b64Bytes(b64) {
    try { return new Uint8Array(await (await fetch("data:application/octet-stream;base64," + b64)).arrayBuffer()); }
    catch (_) { return fromB64(b64); }
  }
  // долгие операции: C# отвечает позже через __native.resolve(reqId, json, error)
  const pending = new Map();
  let reqSeq = 0;
  const callAsync = (method, ...args) => new Promise((resolve, reject) => {
    const id = "r" + (++reqSeq);
    pending.set(id, { resolve, reject });
    call(method, id, ...args).catch((e) => { pending.delete(id); reject(e); });
  });
  const jsonAsync = async (method, ...args) => {
    const r = await callAsync(method, ...args);
    return r === null || r === undefined || r === "" ? null : JSON.parse(r);
  };
  const json = async (method, ...args) => {
    const r = await call(method, ...args);
    if (r === null || r === undefined || r === "") return null;
    return typeof r === "string" ? JSON.parse(r) : r;
  };

  // ---------- base64 ----------
  function toB64(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    const s = atob(b64 || "");
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }

  function thumbnail(src) {
    return new Promise((res) => {
      if (!src) return res(null);
      const img = new Image();
      img.onload = () => {
        try {
          const w = 120, h = Math.round((img.naturalHeight / img.naturalWidth) * w) || 170;
          const c = document.createElement("canvas");
          c.width = w; c.height = Math.min(h, 200);
          c.getContext("2d").drawImage(img, 0, 0, w, h);
          res(c.toDataURL("image/jpeg", 0.75));
        } catch (_) { res(null); }
      };
      img.onerror = () => res(null);
      img.src = src;
    });
  }

  // ---------- библиотека: SQLite + файлы на устройстве ----------
  const CHUNK = 768 * 1024;     // чтение файла книги из приложения
  const UPLOAD = 192 * 1024;    // запись в приложение (идёт через заголовки — частями)
  const NativeLibrary = {
    async list() { return (await json("LibList")) || []; },
    get: (id) => json("LibGet", id),
    async getFile(id, signal) {
      const info = await json("LibFileInfo", id);
      if (!info) return null;
      const stop = () => { if (signal && signal.aborted) { const e = new Error("открытие отменено"); e.name = "AbortError"; throw e; } };
      const out = new Uint8Array(info.size);
      // куски читаются параллельно; ответ — base64 без второй упаковки (CallRaw), декодирует браузер
      const offs = [];
      for (let off = 0; off < info.size; off += CHUNK) offs.push(off);
      await Promise.all(offs.map(async (off) => {
        stop();   // открыли другую книгу — оставшиеся куски этой не читаем
        const part = await b64Bytes(await callRaw("LibReadChunk", id, off, Math.min(CHUNK, info.size - off)));
        out.set(part, off);
      }));
      return { name: info.name, type: info.type || "", data: out.buffer };
    },
    update: (id, patch) => call("LibUpdate", id, JSON.stringify(patch)),
    async add(file, buf, book) {
      const token = await call("LibBeginAdd", file.name, file.type || "", buf.byteLength);
      const u8 = new Uint8Array(buf);
      for (let off = 0; off < u8.length; off += UPLOAD) await call("LibAppend", token, toB64(u8.subarray(off, off + UPLOAD)));
      const meta = { title: book.title, authors: book.authors, format: book.format, formatLabel: book.formatLabel, cover: await thumbnail(book.cover) };
      return json("LibFinishAdd", token, JSON.stringify(meta));
    },
    // чтение файла кусками (аудиокниги: теги, главы) — без загрузки всего файла через мост
    async reader(id) {
      const info = await json("LibFileInfo", id);
      if (!info) return null;
      return AudioMeta.cachedReader({ size: info.size, read: async (off, len) => (len > 0 ? b64Bytes(await callRaw("LibReadChunk", id, off, Math.min(len, info.size - off))) : new Uint8Array(0)) });
    },
    // собрать аудиокнигу (несколько файлов или архив со сжатием) в один ZIP без сжатия: { id, name, isNew }
    packAudio: (ids, name) => jsonAsync("LibAudioPackAsync", JSON.stringify(ids), name),
    remove: (id) => call("LibRemove", id),
    clear: () => call("LibClear"),
    estimate: () => json("LibEstimate"),
    migrateOld: async () => null,
    // выбор файлов системным диалогом: [{ id, name, isNew }]
    async pickFiles() { return (await jsonAsync("LibPickFilesAsync")) || []; },
    thumbnail,
  };
  window.Library = NativeLibrary;

  // ---------- нативный плеер ----------
  // подпись набора фраз: если приложение уже получало эту книгу (переключились туда и обратно),
  // заново все фразы через мост не шлём — это сотни килобайт на больших книгах
  function segsSig(segs) {
    let h = 0x811c9dc5;
    for (const s of segs) {
      const t = s.text + "\u0001" + s.pause + "\u0002";
      for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
    }
    return segs.length + "-" + (h >>> 0).toString(36);
  }
  // Книги в плеер отправляются строго по очереди: иначе при быстрых переключениях А → Б длинная
  // отправка А могла закончиться позже короткой Б, и плеер остался бы с книгой А.
  // Устаревшую отправку (уже выбрана другая книга) пропускаем.
  let queueReady = Promise.resolve(), queueSeq = 0;
  async function sendQueue(my, bookId, title, segs) {
    if (my !== queueSeq) return;
    const sig = segsSig(segs);
    if ((await call("PlayerUseQueue", bookId, title, sig)) === "1") return;
    if (my !== queueSeq) return;
    await call("PlayerSetQueue", bookId, title, JSON.stringify(segs.map((s) => [s.text, s.pause])), sig);
  }
  const Player = {
    setQueue: (bookId, title, segs) => {
      const my = ++queueSeq;
      return (queueReady = queueReady.catch(() => {}).then(() => sendQueue(my, bookId, title, segs)));
    },
    // «читать» сразу после открытия книги — дождаться, пока приложение получит её фразы
    play: async (index, voice, rate) => { await queueReady.catch(() => {}); return call("PlayerPlay", index, voice, rate); },
    pause: () => call("PlayerPause"),
    sleep: (minutes, atIndex) => call("PlayerSleep", minutes, atIndex),   // таймер сна (в старом клиенте метода нет — ошибка глотается)
    resume: async (index, voice, rate) => { await queueReady.catch(() => {}); return call("PlayerResume", index, voice, rate); },
    stop: () => call("PlayerStop"),
    setRate: (r) => call("PlayerSetRate", r),
    setVoice: (v) => call("PlayerSetVoice", v),
    state: () => json("PlayerState"), // { index, playing, loading }
  };

  // ---------- скачанная озвучка ----------
  const Audio = {
    status: async () => (await json("PreloadStatus")) || [],   // [{ bookId, voice, total, done, bytes, running, queued, jobDone, jobTotal, error, stale, unknown }]
    start: (bookId, title, voice, from, to) => call("PreloadStart", bookId, title, voice, from, to),
    cancel: (bookId) => call("PreloadCancel", bookId),
    // «Освободить место»: сколько занимает лишнее и удалить отмеченное ({ orphans, outdated, temp, all })
    cleanInfo: () => jsonAsync("AudioCleanInfoAsync"),
    clean: (opts) => jsonAsync("AudioCleanAsync", JSON.stringify(opts)),
    // «Обновить»: заново — устаревшие фразы и скачанные до 1.2.0; true — поставлено в загрузку, false — нечего
    refresh: async (bookId, title, voice) => (await call("PreloadRefresh", bookId, title, voice)) === "1",
    remove: (bookId, voice) => call("PreloadDelete", bookId, voice),
    bytes: async () => Number(await call("PreloadBytes")) || 0,
    enqueue: (bookId, title, voice, segs) => call("PreloadEnqueue", bookId, title, voice, JSON.stringify(segs)),
    cancelAll: () => call("PreloadCancelAll"),
    resume: () => call("PreloadResume"),
    hold: () => call("PreloadHold"),
    queue: () => json("PreloadQueue"),
    coverage: async (bookId, voice, starts) => (await jsonAsync("PreloadCoverageAsync", bookId, voice, JSON.stringify(starts))) || [], // [[скачано, всего], ...]
  };

  // ---------- плеер аудиокниг (системный плеер Android, работает в фоне) ----------
  const Ab = {
    // book: { id, title, authors, cover, parts: [{ off, size, duration, mime }], chapters: [{ title, at }] }
    open: (book) => call("AbOpen", JSON.stringify(book)),
    play: (at, rate) => call("AbPlay", at, rate),     // at — секунды от начала книги
    pause: () => call("AbPause"),
    seek: (at) => call("AbSeek", at),
    setRate: (r) => call("AbRate", r),
    sleep: (minutes, chapterEnd) => call("AbSleep", minutes, chapterEnd ? "1" : "0"),   // 0 — выключить
    stop: () => call("AbStop"),
    state: () => json("AbState"),   // { bookId, at, playing, loading, ended, sleepLeft, error }
  };

  const handlers = {};
  window.Native = {
    call, json, Player, Audio, Ab, handlers,
    serverInfo: () => jsonAsync("ServerInfoAsync"),
    openSettings: (find) => call("OpenSettings", find ? "true" : "false"),
    getPref: (k) => call("GetPref", k),
    setPref: (k, v) => call("SetPref", k, v),
    hasServer: async () => (await call("HasServer")) === "true",
    // обновления (шаг 6): версия приложения и открыть ссылку GitHub во внешнем браузере (скачать APK)
    appVersion: async () => { try { return await call("AppVersion"); } catch (_) { return null; } },
    openUrl: (url) => call("OpenUrl", url),
    exit: () => call("ExitApp"),
    log: (line) => call("WebLog", String(line).slice(0, 500)).catch(() => {}),   // в журнал «Для разработчиков» (старый клиент — метода нет, тихо)
    exportBook: (id) => jsonAsync("LibExportAsync", id),
    exportBooks: (ids) => jsonAsync("LibExportManyAsync", JSON.stringify(ids)), // системное «Поделиться» с исходным файлом книги
    catalog: () => jsonAsync("CatalogListAsync"),                       // { items: [...] } из папки catalog сервера
    catalogFetch: (id, name) => jsonAsync("CatalogFetchAsync", id, name), // { id, name, isNew } — уже в библиотеке
    // личные правила произношения (pron.js): сохранены — нативная озвучка берёт текущую заново; «прослушать» — Blob
    pronChanged: () => call("PronChanged").catch(() => {}),
    pronPreview: async (text, voice, extraJson) => {
      const r = await jsonAsync("PronPreviewAsync", text, voice, extraJson);
      if (!r || !r.b64) throw new Error("сервер не ответил");
      const bin = atob(r.b64), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return new Blob([u8], { type: r.mime || "audio/ogg" });
    },
  };

  // цвет темы → фон под системными панелями Android и цвет их значков
  function syncTheme() {
    const hex = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
    if (!m) return;
    const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
    const dark = (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
    call("SetTheme", hex, dark).catch(() => {});
  }
  document.addEventListener("DOMContentLoaded", () => {
    syncTheme();
    new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    // тексты стартового экрана для приложения
    const lines = document.querySelectorAll(".drop p");
    if (lines[0]) lines[0].textContent = "Нажмите, чтобы выбрать книги на устройстве.";
    const hint = document.querySelector(".drop .hint");
    if (hint) hint.textContent = "Книги хранятся в приложении на этом устройстве. Озвучка — сервер BookReader на ПК.";
  });

  // вызовы из C# (EvaluateJavaScriptAsync)
  const fire = (name, ...args) => { try { handlers[name] && handlers[name](...args); } catch (e) { console.error(e); } };
  window.__native = {
    resolve(id, result, error) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error)); else p.resolve(result);
    },
    onSegment: (i) => fire("onSegment", Number(i)),
    onState: (playing, loading) => fire("onState", !!playing, !!loading),
    onError: (msg) => fire("onError", String(msg || "")),
    onEnded: () => fire("onEnded"),
    onSleep: () => fire("onSleep"),
    onServerChanged: () => fire("onServerChanged"),
    onPreload: (st) => fire("onPreload", st),
    onAb: (st) => fire("onAb", st),             // плеер аудиокниг: { bookId, at, playing, loading, ended, sleepLeft, error }   // { bookId, rows: [...] }
    // кнопка «Назад» Android: "handled" — закрыли что-то в читалке, "exit" — закрывать нечего
    onBack: () => { try { return handlers.onBack ? handlers.onBack() : "exit"; } catch (e) { console.error(e); return "exit"; } },
    toast: (msg) => fire("toast", String(msg || "")),
  };
})();
