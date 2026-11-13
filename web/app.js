// если что-то сломалось — показать ошибку на странице, а не молчать
window.addEventListener("error", (e) => {
  const box = document.getElementById("serverWarn");
  if (!box) return;
  box.hidden = false;
  box.innerHTML = "Ошибка в скрипте читалки: <b></b><br>Обновите страницу с очисткой кеша (Ctrl+F5). Если не помогло — сообщите текст ошибки.";
  box.querySelector("b").textContent = (e.message || "неизвестная ошибка") + (e.filename ? " — " + e.filename.split("/").pop() + ":" + e.lineno : "");
});

(function () {
  "use strict";

  const $ = (id) => {
    const n = document.getElementById(id);
    if (!n) throw new Error(`на странице нет элемента #${id} — файлы читалки разных версий`);
    return n;
  };
  const el = {
    reader: $("reader"), empty: $("empty"), drop: $("drop"), file: $("fileInput"),
    title: $("bookTitle"), author: $("bookAuthor"),
    toc: $("toc"), tocList: $("tocList"), scrim: $("scrim"), btnToc: $("btnToc"), tocClose: $("tocClose"),
    play: $("btnPlay"), prev: $("btnPrev"), next: $("btnNext"),
    seek: $("seek"), voice: $("voice"), rate: $("rate"), volume: $("volume"),
    statusMain: $("statusMain"), statusSub: $("statusSub"), player: $("player"),
    setView: $("setView"), setTheme: $("setTheme"), setFont: $("setFont"), setPanel: $("setPanel"), setBack: $("setBack"),
    libView: $("libView"), libHeadTitle: $("libHeadTitle"), btnOpenSettings: $("btnOpenSettings"), btnServer: $("btnServer"),
    warn: $("serverWarn"), warnText: $("warnText"), warnOffline: $("warnOffline"), warnClose: $("warnClose"),
    setServer: $("setServer"), toast: $("toast"),
    lib: $("lib"), btnLib: $("btnLib"), libClose: $("libClose"), libList: $("libList"), libCount: $("libCount"),
    libSearch: $("libSearch"), libSort: $("libSort"), libFiles: $("libFiles"), libUsage: $("libUsage"),
    recent: $("recent"), recentList: $("recentList"),
    main: $("main"), pager: $("pager"), pagePrev: $("pagePrev"), pageNext: $("pageNext"), pageNum: $("pageNum"),
    pageBack: $("pageBack"), pageFwd: $("pageFwd"),
    btnDl: $("btnDl"), dl: $("dl"), dlClose: $("dlClose"), dlBook: $("dlBook"), dlVoice: $("dlVoice"),
    dlModeCh: $("dlModeCh"), dlRange: $("dlRange"), dlFrom: $("dlFrom"), dlTo: $("dlTo"), dlEst: $("dlEst"),
    dlBar: $("dlBar"), dlText: $("dlText"), dlStart: $("dlStart"), dlStop: $("dlStop"), dlDelete: $("dlDelete"),
    dlChapters: $("dlChapters"), dlListen: $("dlListen"), dlPacks: $("dlPacks"),
    btnCatalog: $("btnCatalog"), catPanel: $("catPanel"), catSearch: $("catSearch"), catRefresh: $("catRefresh"),
    catList: $("catList"), catInfo: $("catInfo"),
    dlQueueBar: $("dlQueueBar"), btnSelect: $("btnSelect"), selBar: $("selBar"), selCount: $("selCount"), selAll: $("selAll"),
    selShare: $("selShare"), selAudio: $("selAudio"), selDelete: $("selDelete"), libKind: $("libKind"), btnHome: $("btnHome"),
  };

  // ---------- настройки ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("fb2r:" + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem("fb2r:" + k, JSON.stringify(v)); } catch (_) {} },
  };
  const settings = {
    theme: store.get("theme", "paper"),
    font: store.get("font", 20),
    voice: store.get("voice", null),
    rate: store.get("rate", 1),
    volume: store.get("volume", 1),
    view: store.get("view", "paged"), // paged (книжный, по умолчанию) | scroll
  };
  const THEMES = ["paper", "light", "dark"];

  function applyLook() {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.style.setProperty("--read-size", settings.font + "px");
  }
  applyLook();

  function toast(msg, ms = 2600) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.toast.classList.remove("show"), ms);
  }

  // ---------- состояние ----------
  let book = null;          // результат Books.parse
  let bookId = null;        // id книги в библиотеке
  let segs = [];            // [{ text, node, pause, toc, sec }]
  let sections = [];        // части книги: [{ el, start, end }] — в постраничном режиме в DOM только одна
  let groups = [];          // режим прокрутки: части собраны в группы ~24 тыс. знаков — браузер раскладывает только видимые группы
  let curSec = 0;
  let cur = 0;
  let playing = false;
  let gen = 0;              // поколение воспроизведения, чтобы отбрасывать устаревшее
  const Native = window.Native || null; // приложение BookReaderClient: плеер и хранилище — нативные
  const audio = new Audio();
  audio.preload = "auto";
  if ("preservesPitch" in audio) audio.preservesPitch = true;
  audio.volume = settings.volume;

  // ---------- разбиение на фрагменты ----------
  const MAX_SEG = 260;
  function splitSentences(text) {
    // режем только по «знак + пробел», и не после сокращений (г., в., вв., т. д., инициалов)
    const raw = text.split(/(?<=[.!?…]["»”)]*\s+)/);
    const parts = [];
    const ABBR = /(?:^|[\s(«"])(?:[а-яёa-z]{1,3}|[А-ЯЁA-Z]|[IVXLC]+|т\.\s?[а-я]|и\.\s?[а-я])\.\s*$/;
    for (const r of raw) {
      if (parts.length && ABBR.test(parts[parts.length - 1]) && /^[а-яёa-z0-9]/.test(r)) parts[parts.length - 1] += r;
      else if (parts.length && /(?:^|\s)[А-ЯЁ]\.\s*$/.test(parts[parts.length - 1]) && /^[А-ЯЁ]/.test(r)) parts[parts.length - 1] += r;
      else parts.push(r);
    }
    const out = [];
    let buf = "";
    const flush = () => { if (buf.trim()) out.push(buf); buf = ""; };
    for (let p of parts) {
      if (!p) continue;
      while (p.length > 420) { // очень длинное предложение режем по запятым/тире
        let cut = -1;
        // ищем только в первых 364 знаках: совпадение, начинающееся до 360-го, целиком в них помещается.
        // Результат тот же, что при поиске по всему остатку, но без просмотра всего текста на каждом разрезе
        // (текст без знаков препинания в сотни килобайт резался секунду).
        const win = p.slice(0, 364);
        for (const re of [/[;:]\s/g, /,\s/g, /\s[—–-]\s/g, /\s/g]) {
          let m; re.lastIndex = 0;
          while ((m = re.exec(win)) && m.index < 360) cut = m.index + m[0].length;
          if (cut > 80) break;
        }
        if (cut <= 0) cut = 360;
        flush();
        out.push(p.slice(0, cut));
        p = p.slice(cut);
      }
      if (buf && (buf + p).length > MAX_SEG) flush();
      buf += p;
    }
    flush();
    return out;
  }

  // ---------- отрисовка книги ----------
  // книга делится на части (главы; длинные — на куски), чтобы постраничный режим не раскладывал всю книгу сразу
  const SECTION_CHARS = 24000;
  const LONG_P = 12000, LONG_PIECE = 3000;
  const SPECIAL_KINDS = new Set(["title", "subtitle", "verse", "author", "empty", "image", "pre"]);  // абзац длиннее LONG_P — кусками по ~LONG_PIECE знаков
  // ---------- асинхронность: отмена и уступка интерфейсу ----------
  const abortError = () => { const e = new Error("открытие отменено"); e.name = "AbortError"; return e; };
  const checkAbort = (signal) => { if (signal && signal.aborted) throw abortError(); };
  const isAbort = (e) => !!e && e.name === "AbortError";
  // отдать управление браузеру (отрисовка, касания), потом продолжить
  const yieldUI = () => new Promise((r) => (window.scheduler && scheduler.yield ? scheduler.yield().then(r) : setTimeout(r, 0)));
  const SLICE_MS = 40;    // столько максимум работаем подряд, потом уступаем интерфейсу

  // Строит разметку книги вне страницы, порциями по SLICE_MS (интерфейс отзывчив, старая книга видна),
  // и проверяет отмену между порциями. В страницу результат вставляет showBook — одним коротким шагом.
  async function buildBook(b, signal) {
    const out = { segs: [], sections: [], toc: [], blobUrls: [b.cover, ...b.items.map((i) => i.src)].filter((u) => u && u.startsWith("blob:")) };
    const S = out.segs, SEC = out.sections;
    let secEl = null, secChars = 0, secHasText = false;
    const newSection = () => {
      if (SEC.length) SEC[SEC.length - 1].end = S.length;
      secEl = document.createElement("div");
      secEl.className = "sec";
      SEC.push({ el: secEl, start: S.length, end: S.length, chars: 0, blocks: 0, heads: 0, imgs: 0 });
      secChars = 0; secHasText = false;
    };
    newSection();
    const addSegs = (node, parts, lastPause) => {
      parts.forEach((txt, k) => {
        const sp = document.createElement("span");
        sp.className = "seg";
        sp.textContent = txt;
        sp.dataset.i = S.length;
        node.appendChild(sp);
        S.push({ text: txt.trim(), node: sp, pause: k === parts.length - 1 ? lastPause : 0.12 });
      });
    };
    const fillSegs = (node, text, pause) => addSegs(node, splitSentences(text), pause);

    const intro = document.createElement("header");
    intro.className = "book-intro";
    if (b.cover) {
      const img = document.createElement("img");
      img.className = "cover"; img.src = b.cover; img.alt = "Обложка";
      intro.appendChild(img);
    }
    if (b.authors.length) {
      const au = document.createElement("div");
      au.className = "bi-author"; au.textContent = b.authors.join(", ");
      intro.appendChild(au);
    }
    const t = document.createElement("div");
    t.className = "bi-title";
    intro.appendChild(t);
    if (b.annotation.length) {
      const an = document.createElement("div");
      an.className = "annotation";
      b.annotation.forEach((p) => { const e = document.createElement("p"); e.textContent = p; an.appendChild(e); });
      intro.appendChild(an);
    }
    secEl.appendChild(intro);
    // название (с автором) — первый фрагмент озвучки
    addSegs(t, [b.title], 0.8);
    S[0].text = (b.authors.length ? b.authors.join(", ") + ". " : "") + b.title;

    // Огромный абзац (текст без разбивки на абзацы, сотни килобайт) — несколькими элементами-продолжениями
    // без отступа: выглядит как один абзац, а браузер раскладывает только видимые куски.
    // Фразы и паузы — те же, что при обычном абзаце.
    const longParagraph = (it) => {
      const parts = splitSentences(it.text);
      let node = null, chars = 0;
      parts.forEach((txt, k) => {
        if (!node || chars > LONG_PIECE) {
          if (node) {
            secEl.appendChild(node);
            if (secChars > SECTION_CHARS) newSection();
          }
          node = document.createElement("p");
          node.className = (it.cls ? it.cls + " " : "") + (k ? "cont" : "");
          chars = 0;
        }
        addSegs(node, [txt], k === parts.length - 1 ? 0.35 : 0.12);
        chars += txt.length;
        secChars += txt.length;
        const X = SEC[SEC.length - 1]; X.chars += txt.length; if (chars === txt.length) X.blocks++;
        secHasText = true;
      });
      if (node) secEl.appendChild(node);
    };

    const itemSeg = []; // индекс первого фрагмента, начиная с элемента i
    let sliceStart = performance.now();
    for (let i = 0; i < b.items.length; i++) {
      if (performance.now() - sliceStart > SLICE_MS) {
        await yieldUI();
        checkAbort(signal);
        sliceStart = performance.now();
      }
      const it = b.items[i];
      // новая часть: перед заголовком главы (если в текущей уже есть текст) или когда часть стала слишком большой
      const isChapter = it.kind === "title" && (it.level || 1) <= 2 && !it.cls;
      if ((isChapter && secHasText) || (secChars > SECTION_CHARS && (it.kind === "p" || it.kind === "title"))) newSection();
      if (it.kind !== "title" && it.kind !== "empty" && it.kind !== "image") secHasText = true;
      itemSeg[i] = S.length;
      if (!SPECIAL_KINDS.has(it.kind) && (it.text || "").length > LONG_P) { longParagraph(it); continue; }
      secChars += (it.text || "").length;
      { const X = SEC[SEC.length - 1]; X.chars += (it.text || "").length; X.blocks++;
        if (it.kind === "title") X.heads++; else if (it.kind === "image") X.imgs++; }
      let node;
      switch (it.kind) {
        case "title": {
          const lvl = Math.min(4, Math.max(2, (it.level || 1) + 1));
          node = document.createElement("h" + lvl);
          if (it.cls) node.className = it.cls;
          fillSegs(node, it.text, 0.9);
          break;
        }
        case "subtitle": node = document.createElement("p"); node.className = "subtitle"; fillSegs(node, it.text, 0.6); break;
        case "verse": node = document.createElement("p"); node.className = "verse" + (it.cls ? " " + it.cls : ""); fillSegs(node, it.text, 0.25); break;
        case "author": node = document.createElement("p"); node.className = "author"; fillSegs(node, it.text, 0.6); break;
        case "empty": node = document.createElement("div"); node.className = "empty-line"; break;
        case "image": node = document.createElement("img"); node.className = "figure"; node.src = it.src; node.alt = ""; node.loading = "lazy"; break;
        case "pre": node = document.createElement("pre"); fillSegs(node, it.text, 0.35); break;
        default:
          node = document.createElement("p"); if (it.cls) node.className = it.cls; fillSegs(node, it.text, 0.35);
      }
      secEl.appendChild(node);
    }
    SEC[SEC.length - 1].end = S.length;
    SEC.forEach((x, k) => { for (let i = x.start; i < x.end; i++) S[i].sec = k; });
    // группы для режима прокрутки: 1400 коротких глав — это 1400 блоков для раскладки, а групп — десятки
    const G = out.groups = [];
    let g = null;
    SEC.forEach((x, k) => {
      if (!g || g.chars > SECTION_CHARS || g.secs.length >= 40) {
        g = { el: document.createElement("div"), secs: [], chars: 0, blocks: 0, heads: 0, imgs: 0 };
        g.el.className = "secgrp";
        G.push(g);
      }
      g.secs.push(k);
      g.chars += x.chars; g.blocks += x.blocks; g.heads += x.heads; g.imgs += x.imgs;
      g.el.appendChild(x.el);
    });
    sizeSections(G);     // до вставки в страницу: стили на отсоединённых элементах ничего не стоят

    // оглавление (ссылки работают с текущей книгой — к моменту клика это она и есть).
    // Ссылки — блоками по 60: у книги в 1000+ глав браузер раскладывает только видимые блоки.
    const seen = new Set();
    let tg = null;
    for (const entry of b.toc) {
      const si = itemSeg[entry.item];
      if (si === undefined || si >= S.length || seen.has(si)) continue;
      seen.add(si);
      S[si].toc = entry.title;
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = entry.title;
      a.style.paddingLeft = 18 + Math.max(0, entry.level - 1) * 14 + "px";
      a.dataset.seg = si;
      a.onclick = (e) => { e.preventDefault(); closePanels(); navigateTo(si); };
      if (!tg || tg.childElementCount >= 60) {
        tg = document.createElement("div");
        tg.className = "tocgrp";
        out.toc.push(tg);
      }
      tg.appendChild(a);
    }
    for (const x of out.toc) x.style.containIntrinsicSize = `auto ${x.childElementCount * 36}px`;
    checkAbort(signal);
    return out;
  }

  // ---------- аудио: загрузка и кеш ----------
  const cache = new Map(); // idx -> { url, promise, state }
  let inflight = null;
  const AHEAD = 4;

  function voiceKey() { return el.voice.value; }

  // книгу сменили: недокачанные фразы отменяем, готовые освобождаем (иначе они висят в памяти)
  function clearAudioCache() {
    for (const c of cache.values()) {
      if (c.ctl) c.ctl.abort();
      if (c.url) URL.revokeObjectURL(c.url);
      if (c.state === "queued") c.reject(abortError());
    }
    cache.clear();
  }

  function requestSeg(i) {
    let c = cache.get(i);
    if (c && c.voice === voiceKey()) return c;
    if (c && c.url) URL.revokeObjectURL(c.url);
    c = { state: "queued", voice: voiceKey() };
    c.promise = new Promise((res, rej) => { c.resolve = res; c.reject = rej; });
    c.promise.catch(() => {});
    cache.set(i, c);
    pump();
    return c;
  }

  // по одному запросу за раз: сервер всё равно синтезирует последовательно,
  // а так переход в другое место книги не стоит в очереди за устаревшими кусками
  async function pump() {
    if (inflight) return;
    let next = -1;
    for (let i = cur; i < Math.min(segs.length, cur + AHEAD + 1); i++) {
      const c = cache.get(i);
      if (c && c.state === "queued" && c.voice === voiceKey()) { next = i; break; }
    }
    if (next < 0) {
      for (const [i, c] of cache) if (c.state === "queued" && c.voice === voiceKey()) { next = i; break; }
    }
    if (next < 0) return;
    const c = cache.get(next);
    c.state = "loading";
    inflight = c;
    try {
      let resp;
      c.ctl = new AbortController();     // сменили книгу — запрос к серверу отменяется
      const body = JSON.stringify({ text: segs[next].text, speaker: c.voice, pause: segs[next].pause, ...Pron.payload(bookId) });
      for (let attempt = 0; ; attempt++) {
        resp = await fetch("api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: c.ctl.signal,
        });
        // 429 — сервер занят слушателями с других устройств: коротко ждём и повторяем
        if (resp.status !== 429 || attempt >= 2) break;
        const wait = Math.min(5, Number(resp.headers.get("Retry-After")) || 2);
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
      if (!resp.ok) throw new Error(await httpError(resp, "tts"));
      const blob = await resp.blob();
      if (c.ctl.signal.aborted) throw abortError();   // ответ опоздал: книга уже другая — не применяем
      c.url = URL.createObjectURL(blob);
      c.state = "ready";
      c.resolve(c.url);
      setWarn(null);
    } catch (e) {
      c.state = "error";
      c.reject(e);
      if (cache.get(next) === c) cache.delete(next);
    } finally {
      inflight = null;
      pump();
    }
  }

  function prefetch() {
    if (Native) return;
    for (let i = cur; i < Math.min(segs.length, cur + AHEAD + 1); i++) requestSeg(i);
    // чистим далёкие куски и устаревшие очереди
    for (const [i, c] of cache) {
      const far = i < cur - 2 || i > cur + AHEAD + 6;
      if (far || c.voice !== voiceKey()) {
        if (c.state === "loading") continue;
        if (c.url) URL.revokeObjectURL(c.url);
        if (c.state === "queued") c.reject(new Error("cancelled"));
        cache.delete(i);
      }
    }
  }

  // ---------- воспроизведение ----------
  async function playFrom(i) {
    if (!segs.length || !modeAllows("tts")) return;   // автономный режим: чтения вслух нет
    if (Audiobook.playing) Audiobook.pause();          // одновременно звучит что-то одно
    i = Math.max(0, Math.min(segs.length - 1, i));
    restartPhrase = false;
    if (Native) {
      if ((await preferPrepared()) === "cancel") return;
      gen++;
      playing = true;
      setPos(i);
      setLoading(true);
      Native.Player.play(i, el.voice.value, el.rate.value).catch((e) => toast("Плеер: " + e.message));
      updateUI();
      return;
    }
    const my = ++gen;
    playing = true;
    setPos(i);
    audio.pause();
    prefetch();
    setLoading(true);
    let url;
    try {
      url = await cache.get(i).promise;
    } catch (e) {
      if (my !== gen) return;
      setLoading(false);
      if (e.message === "cancelled") return;
      playing = false;
      updateUI();
      const msg = netMessage(e);
      if (e.name === "TypeError") setWarn("down");
      toast("Не удалось озвучить: " + msg, 6000);
      return;
    }
    if (my !== gen) return;
    setLoading(false);
    audio.src = url;
    audio.playbackRate = Number(el.rate.value);
    try {
      await audio.play();
    } catch (e) {
      if (my !== gen) return;
      playing = false;
      toast("Браузер не дал начать воспроизведение — нажмите ▶ ещё раз");
    }
    updateUI();
  }

  audio.addEventListener("ended", () => {
    if (!playing) return;
    if (cur < segs.length - 1) playFrom(cur + 1);
    else { playing = false; updateUI(); toast("Книга дочитана"); }
  });

  // пауза дольше 15 минут: продолжение — с начала фразы, а не с середины слова (в приложении это решает плеер)
  const LONG_PAUSE = 15 * 60 * 1000;
  let pausedAt = 0, restartPhrase = false;
  function pause() {
    playing = false;
    pausedAt = Date.now();
    gen++;
    if (Native) Native.Player.pause();
    audio.pause();
    setLoading(false);
    updateUI();
  }

  async function resume() {
    if (!modeAllows("tts")) return;
    if (Audiobook.playing) Audiobook.pause();
    // выбрана фраза (касание, ползунок, оглавление) — читаем с неё
    if (pick >= 0) return readFrom(pick);
    // место чтения не на экране (перелистнули, прокрутили — читали глазами) — читаем с того, что на экране;
    // вернуться к месту прослушивания — «↩ Вернуться»
    if (segs.length && !readingOnScreen()) {
      const v = screenSeg();
      if (v >= 0 && v !== cur) return readFrom(v);
    }
    if (Native) {
      const choice = await preferPrepared();
      if (choice === "cancel") return;
      if (choice === "switched") return playFrom(cur);
      // плеер сам решит: продолжить с паузы (если стоит на этой же фразе) или начать фразу cur
      playing = true; gen++;
      setLoading(true);
      Native.Player.resume(cur, el.voice.value, el.rate.value).catch((e) => toast("Плеер: " + e.message));
      updateUI();
      return;
    }
    // если текущий кусок уже загружен и стоит на паузе — продолжаем с того же места
    const c = cache.get(cur);
    if (c && c.url && audio.src === c.url && audio.currentTime > 0 && !audio.ended && !restartPhrase && Date.now() - pausedAt < LONG_PAUSE) {
      playing = true;
      gen++;
      audio.playbackRate = Number(el.rate.value);
      audio.play().catch(() => {});
      updateUI();
    } else playFrom(cur);
  }

  function togglePlay() { if (Audiobook.active) return Audiobook.toggle(); if (!segs.length || !modeAllows("tts")) return; playing ? pause() : resume(); }

  function stop() {
    pause();
    if (Native) Native.Player.stop();
    audio.removeAttribute("src");
    audio.load();
    updateUI();
  }

  function jump(i, keepPlaying) {
    if (!segs.length) return;
    i = Math.max(0, Math.min(segs.length - 1, i));
    if (keepPlaying) playFrom(i);
    else if (Native) { setPos(i); updateUI(); }
    else {
      gen++;
      audio.pause();
      audio.removeAttribute("src");
      setPos(i);
      prefetch();
      updateUI();
    }
  }

  // ---------- позиция и интерфейс ----------
  let autoScroll = true;
  let followOnce = false;   // следующий setPos — всё равно показать (переход по команде пользователя)
  function setPos(i) {
    if (segs[cur]) segs[cur].node.classList.remove("current");
    cur = i;
    segs[cur].node.classList.add("current");
    if (pick === cur) setPick(-1);
    el.seek.value = cur;
    // экран идёт за чтением, только если место чтения было на экране: пролистали в сторону — не возвращаем
    // (вернуться — кнопкой «К месту чтения»)
    if (autoScroll && (readVisible || followOnce)) scrollToSeg(cur);
    followOnce = false;
    sleepCheck(i);
    listenT = Date.now();
    savePos();
    updateUI();
    watchReading();
  }

  // ---------- таймер сна ----------
  // Через N минут или в конце главы — пауза. В приложении отсчитывает сам плеер (работает и при выключенном
  // экране, когда страница «спит»); здесь — только показ оставшегося времени и то же самое для браузера.
  const sleepBtn = document.getElementById("btnSleep"), sleepLeft = document.getElementById("sleepLeft");
  let sleep = null;   // { until: мс | 0, atSeg: фраза | -1, chapter: bool }
  const nextChapterStart = (i) => { for (let k = i + 1; k < segs.length; k++) if (segs[k].toc) return k; return -1; };
  function sleepSync() {
    if (Native) Native.Player.sleep(sleep && sleep.until ? Math.max(1, Math.round((sleep.until - Date.now()) / 60000)) : 0,
      sleep ? sleep.atSeg : -1).catch(() => {});
    sleepShow();
  }
  function sleepShow() {
    const on = !!sleep;
    sleepBtn.classList.toggle("on", on);
    sleepLeft.hidden = !on;
    if (!on) { sleepBtn.title = "Таймер сна"; return; }
    if (sleep.chapter) { sleepLeft.textContent = "гл."; sleepBtn.title = "Таймер сна: пауза в конце главы"; return; }
    const min = Math.max(0, Math.ceil((sleep.until - Date.now()) / 60000));
    sleepLeft.textContent = min + "′";
    sleepBtn.title = `Таймер сна: пауза через ${min} мин`;
  }
  function sleepFired(fromPlayer) {
    if (!sleep) return;
    sleep = null;
    if (!fromPlayer && playing) { pause(); restartPhrase = true; }
    sleepShow();
    toast("Таймер сна: чтение на паузе");
  }
  setInterval(() => {
    if (!sleep || !sleep.until) return;
    if (Date.now() >= sleep.until) sleepFired(false); else sleepShow();
  }, 15000);
  // «до конца главы»: дошли до начала следующей — пауза; перешли в другое место — цель пересчитывается
  let sleepLastPos = -1;
  function sleepCheck(i) {
    const prev = sleepLastPos;
    sleepLastPos = i;
    if (!sleep || !sleep.chapter || sleep.atSeg < 0) return;
    const natural = i === prev + 1;
    if (natural && i >= sleep.atSeg) return sleepFired(!!Native);
    if (!natural && (i >= sleep.atSeg || nextChapterStart(i) !== sleep.atSeg)) {
      sleep.atSeg = nextChapterStart(i);
      if (sleep.atSeg < 0) sleep.atSeg = segs.length;   // последняя глава — до конца книги
      sleepSync();
    }
  }
  async function sleepDialog() {
    const opts = [15, 30, 45, 60, 90].map((m) => ({ label: m + " минут", value: m }));
    const v = await ask("Таймер сна", `<p>Чтение встанет на паузу через выбранное время.</p>` +
      (sleep ? `<p><b>Сейчас:</b> ${sleep.chapter ? "пауза в конце главы" : "пауза через " + Math.max(0, Math.ceil((sleep.until - Date.now()) / 60000)) + " мин"}.</p>` : ""),
      [...opts, { label: "До конца главы", value: "chapter" }, ...(sleep ? [{ label: "Выключить таймер", value: "off" }] : [])]);
    if (v === null || v === undefined) return;
    if (v === "off") { sleep = null; sleepSync(); return toast("Таймер сна выключен"); }
    if (v === "chapter") {
      if (!segs.length) return;
      let at = nextChapterStart(cur);
      if (at < 0) at = segs.length;
      sleep = { until: 0, atSeg: at, chapter: true };
      sleepLastPos = cur;
      toast(nextChapterStart(cur) < 0 ? "Таймер сна: до конца книги" : "Таймер сна: пауза в конце главы");
    } else {
      sleep = { until: Date.now() + v * 60000, atSeg: -1, chapter: false };
      toast(`Таймер сна: пауза через ${v} мин`);
    }
    sleepSync();
  }
  sleepBtn.onclick = () => { act("таймер сна"); if (Audiobook.active) Audiobook.sleepDialog(); else sleepDialog(); };

  // ---------- место чтения: выбор фразы, «К месту чтения», «↩ Вернуться» ----------
  // Место чтения (cur: подсветка, прогресс, откуда продолжит ▶) меняется только когда реально начинают слушать
  // с нового места. Касание фразы, ползунок, оглавление без воспроизведения — только смотрят и выбирают фразу (pick).
  let pick = -1;
  const toReading = document.getElementById("toReading");
  const undoBar = document.getElementById("undoBar"), undoText = document.getElementById("undoText");
  const seekMark = document.getElementById("seekMark"), seekTip = document.getElementById("seekTip");

  function setPick(i) {
    if (segs[pick]) segs[pick].node.classList.remove("pick");
    // автономный режим: озвучки нет — касание фразы ничего не выделяет
    pick = i >= 0 && i < segs.length && i !== cur && modeAllows("tts") ? i : -1;
    if (pick >= 0) segs[pick].node.classList.add("pick");
    el.play.title = pick >= 0 ? "Читать с выбранной фразы" : "Воспроизвести / пауза (пробел)";
  }

  // подсказка «двойное касание — читать отсюда» — первые несколько раз, чтобы не надоедать
  let tapHintAt = 0;
  function tapHint() {
    if (!modeAllows("tts")) return;                  // автономный режим: двойное касание ничего не запускает
    const n = Number(store.get("tapHints", 0));
    if (n >= 3 || Date.now() - tapHintAt < 8000) return;
    tapHintAt = Date.now();
    store.set("tapHints", n + 1);
    toast(Native ? "Двойное касание — читать с этой фразы. Долгое нажатие — выделить текст" : "Двойной клик — читать с этой фразы", 3200);
  }
  const pickHint = () => {};

  const chapterOf = (i) => { for (let k = Math.min(i, segs.length - 1); k >= 0; k--) if (segs[k].toc) return segs[k].toc; return book ? book.title : ""; };
  const pctOf = (i) => (segs.length > 1 ? Math.round((i / (segs.length - 1)) * 100) : 0);

  // переход во время чтения (или старт с другого места) — можно вернуться
  const jumpHistory = [];
  let undoT = 0, holdPosUntil = 0;   // после «Вернуться» на паузу запоздалое onSegment плеера не должно сдвинуть место
  // wasPlaying — играло ли до перехода: «Вернуться» восстанавливает и место, и это состояние
  function offerUndo(from, to, wasPlaying = playing) {
    if (from < 0 || Math.abs(to - from) <= 1) return;
    jumpHistory.push({ pos: from, playing: wasPlaying });
    if (jumpHistory.length > 10) jumpHistory.shift();
    undoText.textContent = `Перешли: ${chapterOf(to)} · ${pctOf(to)}%`;
    undoBar.hidden = false;
    clearTimeout(undoT);
    undoT = setTimeout(() => { undoBar.hidden = true; syncToReading(); }, 8000);
    syncToReading();
  }
  document.getElementById("undoBtn").onclick = () => {
    suppressTextTaps(800);   // плашка исчезнет — следующее касание в то же место не должно попасть в текст
    undoBar.hidden = true;
    clearTimeout(undoT);
    const prev = jumpHistory.pop();
    if (prev === undefined || !segs.length) return;
    setPick(-1);
    // переход двойным касанием на паузе запускает чтение; если он был ошибочным, возвращаемся на паузу
    if (!prev.playing && playing) { pause(); holdPosUntil = Date.now() + 1500; }
    jump(prev.pos, prev.playing && playing);
    goToReading();
    toast(`Вернулись: ${chapterOf(prev.pos)} · ${pctOf(prev.pos)}%` + (prev.playing ? "" : " · пауза"));
  };

  // начать слушать с i (с запоминанием, откуда ушли)
  function readFrom(i) {
    if (!modeAllows("tts")) return;
    const from = cur, wasPlaying = playing;
    setPick(-1);
    playFrom(i);
    offerUndo(from, i, wasPlaying);
  }

  // перейти к месту в книге (оглавление, ползунок): место чтения переносится туда — во время чтения
  // чтение продолжается оттуда, на паузе ▶ начнёт оттуда. Ошибся — «↩ Вернуться» вернёт и место, и паузу/чтение.
  function navigateTo(i) {
    if (!segs.length) return;
    i = Math.max(0, Math.min(segs.length - 1, i));
    const from = cur, was = playing;
    setPick(-1);
    if (i !== cur) { jump(i, playing); offerUndo(from, i, was); }
    if (isPaged()) layoutPaged(i); else scrollToSeg(i, "start");
  }

  // показать место чтения
  function goToReading() {
    if (!segs.length) return;
    setPick(-1);
    el.seek.value = cur;
    updateSeekMark();
    if (isPaged()) layoutPaged(cur); else scrollToSeg(cur, "start");
  }
  // Срабатывает на отпускание пальца, а не на «клик»: пока лента ещё катится по инерции, WebView тратит касание
  // на остановку прокрутки и «клик» не присылает — приходилось нажимать 2–3 раза. Сдвинул палец (листает) — не нажатие.
  let trTouch = null, trTouchedAt = 0;
  toReading.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    trTouch = { x: t.clientX, y: t.clientY };
    toReading.classList.add("pressed");
  }, { passive: true });
  toReading.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (trTouch && Math.hypot(t.clientX - trTouch.x, t.clientY - trTouch.y) > 12) { trTouch = null; toReading.classList.remove("pressed"); }
  }, { passive: true });
  toReading.addEventListener("touchend", (e) => {
    toReading.classList.remove("pressed");
    if (!trTouch) return;
    trTouch = null;
    if (e.cancelable) e.preventDefault();   // без «клика» следом
    trTouchedAt = Date.now();
    pressToReading();
  });
  toReading.addEventListener("touchcancel", () => { trTouch = null; toReading.classList.remove("pressed"); });
  toReading.addEventListener("click", () => { if (Date.now() - trTouchedAt > 700) pressToReading(); });   // мышь, клавиатура
  function pressToReading() {
    // Кнопка исчезает, и повторные быстрые нажатия в то же место попали бы в текст под ней — два касания фразы
    // это «читать с неё», и чтение запускалось само. Касания текста сразу после возврата не считаем.
    suppressTextTaps(800);
    toReading.hidden = true;     // отклик сразу, не дожидаясь прокрутки
    clearTimeout(toReadingT);
    goToReading();
  }

  // кнопка «К месту чтения» — когда фраза места чтения не видна (прокрутили, перелистнули, ушли ползунком)
  let readObs = null, readVisible = true;
  function watchReading() {
    if (!window.IntersectionObserver) return;
    if (!readObs) readObs = new IntersectionObserver((ents) => {
      for (const e of ents) if (segs[cur] && e.target === segs[cur].node) readVisible = e.isIntersecting;
      syncToReading();
    });
    readObs.disconnect();
    if (segs[cur]) readObs.observe(segs[cur].node);
  }
  // При появлении кнопка раскрывается с подписью, через пару секунд сворачивается в точку и становится
  // полупрозрачной — заметна, но не мешает читать. Касание или наведение — снова полностью видна.
  let toReadingT = 0;
  function syncToReading() {
    const off = segs.length > 0 && (!readVisible || !segs[cur] || !segs[cur].node.isConnected);
    const show = off && undoBar.hidden;
    if (show === !toReading.hidden) return;
    toReading.hidden = !show;
    clearTimeout(toReadingT);
    if (!show) return;
    positionToReading();
    toReading.classList.remove("dot", "dim");
    toReadingT = setTimeout(() => {
      toReading.classList.add("dot");
      toReadingT = setTimeout(() => toReading.classList.add("dim"), 450);
    }, 3250);   // подпись видна ~3 с — успеть прочитать и понять, что это за кнопка
  }

  // Кнопка — в правом нижнем углу самого текста: в ленте — колонки текста, в книжном режиме — страницы (разворота),
  // а не в углу экрана и не на полях.
  function positionToReading() {
    const area = isPaged() ? el.pager : el.reader;
    const r = area && area.getBoundingClientRect();
    if (!r || !r.width) { toReading.style.right = toReading.style.bottom = ""; return; }
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const right = Math.max(8, vw - r.right);
    let bottom = el.player.offsetHeight + 12;
    if (isPaged()) bottom = Math.max(bottom, vh - r.bottom + 6);
    toReading.style.right = right + "px";
    toReading.style.bottom = bottom + "px";
  }
  window.addEventListener("resize", () => { if (!toReading.hidden) positionToReading(); });

  // метка места чтения на ползунке — когда ползунок показывает другое место
  function updateSeekMark() {
    const show = segs.length > 1 && Number(el.seek.value) !== cur;
    seekMark.hidden = !show;
    if (show) seekMark.style.left = thumbX(cur) + "px";
  }
  function thumbX(i) {
    const w = el.seek.clientWidth, t = 16;   // ширина «бегунка» — примерно
    return el.seek.offsetLeft + t / 2 + (segs.length > 1 ? i / (segs.length - 1) : 0) * (w - t);
  }

  let scrollGen = 0;
  function scrollToSeg(i, mode) {
    const n = segs[i] && segs[i].node;
    if (!n) return;
    if (isPaged()) {
      if (segs[i].sec !== curSec) layoutPaged(i);
      else { const p = pageOfSeg(i); if (p !== page) goToPage(p); }
      return;
    }
    const r = n.getBoundingClientRect();
    const top = 70, bottom = window.innerHeight - el.player.offsetHeight - 20;
    const my = ++scrollGen;     // новая прокрутка отменяет поправки предыдущей
    const want = mode === "start" ? r.top - 90 : (r.top < top || r.bottom > bottom) ? r.top - (bottom - top) * 0.35 : null;
    if (want === null) return;
    // переход (оглавление, открытие книги) или далеко — сразу, без плавной прокрутки: главы по пути ещё не
    // разложены, их высота уточняется при показе, поэтому положение подправляем ещё пару кадров
    if (mode === "start" || Math.abs(want) > window.innerHeight * 2) {
      window.scrollTo({ top: window.scrollY + want, behavior: "instant" });
      let tries = 3;
      const fix = () => {
        if (my !== scrollGen || isPaged() || !n.isConnected) return;
        const rr = n.getBoundingClientRect();
        const d = mode === "start" ? rr.top - 90 : (rr.top < top || rr.bottom > bottom) ? rr.top - (bottom - top) * 0.35 : 0;
        if (Math.abs(d) > 4) window.scrollTo({ top: window.scrollY + d, behavior: "instant" });
        if (--tries > 0) requestAnimationFrame(fix);
      };
      requestAnimationFrame(fix);
      return;
    }
    window.scrollTo({ top: window.scrollY + want, behavior: "smooth" });
  }

  // ---------- постраничный режим ----------
  // В DOM — только текущая часть книги (глава): раскладка колонками всей книги на телефоне слишком тяжёлая.
  let page = 0, pages = 1, stride = 1;
  const isPaged = () => settings.view === "paged" && segs.length > 0;

  function attachAll() {
    // части, которые постраничный режим вынимал из групп, возвращаем на место
    for (const g of groups) if (g.secs.some((k) => sections[k].el.parentNode !== g.el)) g.el.replaceChildren(...g.secs.map((k) => sections[k].el));
    el.reader.replaceChildren(...groups.map((g) => g.el));
  }

  // В режиме прокрутки браузер раскладывает только видимые главы (content-visibility: auto в style.css),
  // остальные занимают место по оценке высоты — иначе открытие большой книги на телефоне идёт секундами.
  // После первого показа браузер запоминает настоящую высоту главы («auto»), оценка нужна только до него.
  function sizeSections(list = groups) {
    if (!list.length) return;
    const fs = settings.font, lh = fs * 1.65;
    // ширину не меряем (это заставило бы браузер разложить всю книгу) — колонка текста: до 42rem, минус поля
    const width = Math.min(42 * 16, window.innerWidth - 36);
    const cpl = Math.max(12, width / (fs * 0.52));      // букв в строке
    for (const S of list) {
      const h = (S.chars / cpl) * lh + S.blocks * lh * 0.5 + S.heads * fs * 4 + S.imgs * 320 + 40;
      S.el.style.containIntrinsicSize = `auto ${Math.round(h)}px`;
    }
  }
  function attachOnly(k) {
    if (el.reader.childElementCount === 1 && el.reader.firstChild === sections[k].el) return;
    el.reader.replaceChildren(sections[k].el);
  }
  const secOf = (i) => (segs[i] ? segs[i].sec : curSec);

  function applyView() {
    const paged = settings.view === "paged";
    if (el.setView) el.setView.value = settings.view;
    const on = paged && segs.length > 0;
    const was = document.body.classList.contains("paged");
    const anchor = segs.length ? (was ? layoutAnchor() : firstVisibleSeg()) : 0;
    document.body.classList.toggle("paged", on);
    if (on) layoutPaged(anchor);
    else {
      el.pager.removeAttribute("style"); el.reader.style.cssText = "";
      document.body.classList.remove("spread", "nav-bottom");
      if (segs.length) {
        attachAll();
        requestAnimationFrame(() => scrollToSeg(anchor, "start"));
      }
    }
    requestAnimationFrame(() => { if (!toReading.hidden) positionToReading(); });   // лента ⇄ страницы: другой угол
  }

  function firstVisibleSeg() {
    const top = el.main.getBoundingClientRect().top + 70;
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (segs[mid].node.getBoundingClientRect().bottom < top) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // реальная высота плеера (на телефоне он в две строки) — чтобы страница и кнопки не уходили под него
  function syncPlayerHeight() {
    document.documentElement.style.setProperty("--player-h", el.player.offsetHeight + "px");
  }
  window.addEventListener("resize", syncPlayerHeight);
  syncPlayerHeight();

  // размеры страницы и число страниц текущей части
  function measure() {
    syncPlayerHeight();
    const mainW = el.main.clientWidth;
    // боковые кнопки ставим, только если после них остаётся нормальная ширина текста
    const btnW = 68, btnMargin = 14, textGap = 16;
    const sideWithButtons = btnMargin + btnW + textGap;
    const narrow = mainW - sideWithButtons * 2 < 420;
    document.body.classList.toggle("nav-bottom", narrow);
    const side = narrow ? 18 : sideWithButtons;
    const W = mainW - side * 2;
    const H = el.main.clientHeight - 28 - 48; // снизу — место под полосу с номером/кнопками
    const gap = narrow ? 32 : 64;
    const cols = W >= 2 * 440 + gap ? 2 : 1;
    const colW = Math.floor(Math.min(cols === 2 ? 620 : 720, (W - gap * (cols - 1)) / cols));
    const pagerW = cols * colW + gap * (cols - 1);
    el.pager.style.width = pagerW + "px";
    el.pager.style.height = H + "px";
    el.reader.style.columnWidth = colW + "px";
    el.reader.style.columnGap = gap + "px";
    el.reader.style.width = pagerW + "px";
    document.documentElement.style.setProperty("--page-h", H + "px");
    document.body.classList.toggle("spread", cols === 2);
    stride = pagerW + gap;
    el.reader.style.transform = "translateX(0)";
    pages = Math.max(1, Math.ceil((el.reader.scrollWidth + gap - 2) / stride));
    if (!toReading.hidden) positionToReading();
  }

  function noAnim(fn) {
    document.body.classList.add("no-anim");
    fn();
    requestAnimationFrame(() => document.body.classList.remove("no-anim"));
  }

  // показать часть книги, где фраза anchorSeg, и страницу с ней
  function layoutPaged(anchorSeg) {
    if (!isPaged()) return;
    const i = anchorSeg === undefined ? cur : anchorSeg;
    noAnim(() => {
      curSec = secOf(i);
      attachOnly(curSec);
      measure();
      goToPage(pageOfSeg(i), false);
    });
  }

  // перейти к части k: на первую или последнюю её страницу
  function showSection(k, toLast) {
    noAnim(() => {
      curSec = Math.max(0, Math.min(sections.length - 1, k));
      attachOnly(curSec);
      measure();
      goToPage(toLast ? pages - 1 : 0, false);
    });
  }

  function pageOfSeg(i) {
    const n = segs[i] && segs[i].node;
    if (!n || segs[i].sec !== curSec || !n.isConnected) return 0;
    const rects = n.getClientRects();
    const r = rects.length ? rects[0] : n.getBoundingClientRect();
    const x = r.left - el.reader.getBoundingClientRect().left;
    return Math.max(0, Math.min(pages - 1, Math.floor((x + 2) / stride)));
  }

  const onScreen = (i) => segs[i] && segs[i].sec === curSec && pageOfSeg(i) === page;

  // за что держаться при пересчёте страниц: за читаемую фразу, если она на экране, иначе — за начало страницы
  function layoutAnchor() { return onScreen(cur) ? cur : firstSegOnPage(page); }

  function firstSegOnPage(p) {
    const s = sections[curSec];
    if (!s || s.end <= s.start) return s ? Math.min(s.start, segs.length - 1) : 0;
    let lo = s.start, hi = s.end - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pageOfSeg(mid) < p) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function goToPage(p, animate = true) {
    page = Math.max(0, Math.min(pages - 1, p));
    if (!animate) document.body.classList.add("no-anim");
    el.reader.style.transform = `translateX(${-page * stride}px)`;
    if (!animate) requestAnimationFrame(() => document.body.classList.remove("no-anim"));
    const atStart = curSec === 0 && page === 0;
    const atEnd = curSec >= sections.length - 1 && page >= pages - 1;
    el.pagePrev.disabled = el.pageBack.disabled = atStart;
    el.pageNext.disabled = el.pageFwd.disabled = atEnd;
    el.pageNum.textContent = `${page + 1} / ${pages}` + (sections.length > 1 ? `  ·  раздел ${curSec + 1} из ${sections.length}` : "");
    requestAnimationFrame(syncToReading);   // перелистнули — место чтения могло уйти с экрана
    noteView();
  }

  function turn(d) {
    if (!isPaged()) return;
    if (d > 0) {
      if (page < pages - 1) goToPage(page + 1);
      else if (curSec < sections.length - 1) showSection(curSec + 1, false);
    } else {
      if (page > 0) goToPage(page - 1);
      else if (curSec > 0) showSection(curSec - 1, true);
    }
  }

  // картинки догружаются и сдвигают текст — пересчитываем страницы, оставаясь на том же месте
  let imgT = 0;
  el.reader.addEventListener("load", (e) => {
    if (!isPaged() || e.target.tagName !== "IMG") return;
    clearTimeout(imgT);
    const anchor = layoutAnchor();
    imgT = setTimeout(() => layoutPaged(anchor), 120);
  }, true);

  el.pagePrev.onclick = el.pageBack.onclick = (e) => { e.stopPropagation(); turn(-1); };
  el.pageNext.onclick = el.pageFwd.onclick = (e) => { e.stopPropagation(); turn(1); };

  let wheelLock = 0;
  el.main.addEventListener("wheel", (e) => {
    if (!isPaged()) return;
    e.preventDefault();
    const now = Date.now();
    if (now < wheelLock || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 4) return;
    wheelLock = now + 320;
    turn((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) > 0 ? 1 : -1);
  }, { passive: false });
  let touchX = null, touchY = null, touchT = 0, moveT = 0;
  el.main.addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; touchT = Date.now(); moveT = 0; }, { passive: true });
  el.main.addEventListener("touchmove", (e) => {
    if (!moveT && touchX !== null && Math.hypot(e.touches[0].clientX - touchX, e.touches[0].clientY - touchY) > 10) moveT = Date.now();
  }, { passive: true });
  el.main.addEventListener("touchend", (e) => {
    if (!isPaged() || touchX === null || swipeHandled) { touchX = null; return; }
    // долгое нажатие (палец сначала стоял — это выделение текста) или есть выделение — не перелистывание
    if ((moveT || Date.now()) - touchT > 450 || String(window.getSelection() || "")) { touchX = null; return; }
    const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) turn(dx < 0 ? 1 : -1);
    touchX = null;
  });
  let resizeT = 0;
  window.addEventListener("resize", () => {
    if (!isPaged()) return;
    clearTimeout(resizeT);
    const anchor = layoutAnchor();
    resizeT = setTimeout(() => layoutPaged(anchor), 150);
  });

  function currentChapter() {
    for (let i = cur; i >= 0; i--) if (segs[i].toc) return segs[i].toc;
    return book ? book.title : "";
  }

  function setLoading(on) { document.body.classList.toggle("loading", on); }

  function updateUI() {
    if (Audiobook.active) return Audiobook.renderBar();   // открыта аудиокнига — плеер внизу её
    const has = segs.length > 0;
    document.body.classList.toggle("playing", playing);
    [el.play, el.prev, el.next, el.seek].forEach((b) => (b.disabled = !has));
    if (!has) { el.statusMain.textContent = "Нет книги"; el.statusSub.innerHTML = "&nbsp;"; seekMark.hidden = true; toReading.hidden = true; return; }
    updateSeekMark();
    syncToReading();
    el.statusMain.textContent = currentChapter();
    const pct = segs.length > 1 ? Math.round((cur / (segs.length - 1)) * 100) : 0;
    el.statusSub.textContent = `${pct}% · фрагмент ${cur + 1} из ${segs.length}` + (playing ? "" : " · пауза");
    el.play.title = playing ? "Пауза (пробел)" : "Читать вслух (пробел)";
    document.querySelectorAll("#tocList a.current").forEach((a) => a.classList.remove("current"));
    let tocIdx = -1;
    for (let i = cur; i >= 0; i--) if (segs[i].toc) { tocIdx = i; break; }
    const a = el.tocList.querySelector(`a[data-seg="${tocIdx}"]`);
    if (a) a.classList.add("current");

    if ("mediaSession" in navigator && book) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentChapter(), artist: book.authors.join(", "), album: book.title,
        artwork: book.cover ? [{ src: book.cover }] : [],
      });
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    }
  }

  let saveT = 0;
  // ---------- чтение глазами (без озвучки) ----------
  // На паузе человек листает и читает сам. Задержался на странице/экране — это место и есть позиция в книге:
  // её сохраняем (прогресс, место при следующем открытии). Место прослушивания (cur) при этом не трогаем —
  // к нему ведёт «К месту чтения»; ▶ начнёт с того, что на экране (см. resume).
  const DWELL_MS = 4000;
  let viewAt = -1, viewT = 0, listenT = 0, dwellT = 0;
  const readingOnScreen = () => (isPaged() ? onScreen(cur) : readVisible);
  // первая фраза на экране: в книжном — начало страницы, в ленте — верхняя видимая строка текста
  function screenSeg() {
    if (!segs.length) return -1;
    if (isPaged()) return firstSegOnPage(page);
    const r = el.reader.getBoundingClientRect();
    const bar = document.querySelector(".topbar");
    const top = Math.max(r.top, bar ? bar.getBoundingClientRect().bottom : 60) + 8;
    const bottom = window.innerHeight - el.player.offsetHeight - 8;
    for (let y = top; y < bottom; y += 14) {
      for (const x of [r.left + r.width * 0.3, r.left + r.width * 0.5, r.left + 40]) {
        const n = document.elementFromPoint(x, y);
        const sg = n && n.closest && n.closest(".seg");
        if (sg) return Number(sg.dataset.i);
      }
    }
    return -1;
  }
  function noteView() {
    clearTimeout(dwellT);
    if (!segs.length || playing) return;
    dwellT = setTimeout(() => {
      if (playing || !segs.length || readingOnScreen()) { viewT = 0; return; }   // вернулись к месту прослушивания
      const v = screenSeg();
      if (v < 0) return;
      viewAt = v; viewT = Date.now();
      savePos();
    }, DWELL_MS);
  }
  // что сохранять: место, где читали глазами (если это было после прослушивания), иначе место прослушивания
  const savedPos = () => (viewT > listenT && viewAt >= 0 && viewAt < segs.length ? viewAt : cur);
  window.addEventListener("scroll", () => { if (!isPaged()) noteView(); }, { passive: true });

  function savePos() {
    clearTimeout(saveT);
    saveT = setTimeout(flushPos, 600);
  }
  function flushPos() {
    clearTimeout(saveT);
    if (!bookId || !segs.length) return;
    const pos = savedPos();
    const progress = segs.length > 1 ? pos / (segs.length - 1) : 0;
    const id = bookId;
    Library.update(id, { pos, segCount: segs.length, progress, openedAt: Date.now() })
      .then(() => { const m = libCache.find((x) => x.id === id); if (m) Object.assign(m, { pos, progress }); updateLibProgress(id, progress); })
      .catch(() => {});
  }

  // ---------- открытие книги ----------
  let blobUrls = [];
  function releaseBook() {
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
    blobUrls = [];
  }

  // Недавно открытые книги держим готовыми (разобранный файл + разметка): переключение между ними —
  // это просто вставка готовых глав, без чтения файла, разбора и создания тысяч элементов заново.
  const bookCache = new Map();          // id → { b, segs, sections, toc, blobUrls }
  const CACHE_BOOKS = 3, CACHE_SEGS = 25000;
  function stashBook() {
    if (!book || !bookId || !segs.length) return releaseBook();
    if (segs[cur]) segs[cur].node.classList.remove("current");
    bookCache.delete(bookId);
    bookCache.set(bookId, { b: book, segs, sections, groups, toc: [...el.tocList.childNodes], blobUrls });
    blobUrls = [];                      // картинки теперь принадлежат кэшу
    let total = 0;
    for (const e of bookCache.values()) total += e.segs.length;
    while (bookCache.size > CACHE_BOOKS || (total > CACHE_SEGS && bookCache.size > 1)) {
      const [k, e] = bookCache.entries().next().value;
      bookCache.delete(k);
      total -= e.segs.length;
      e.blobUrls.forEach((u) => URL.revokeObjectURL(u));
    }
  }
  function forgetBook(id) {
    const e = bookCache.get(id);
    if (!e) return;
    bookCache.delete(id);
    e.blobUrls.forEach((u) => URL.revokeObjectURL(u));
  }
  { // удалили книгу (или всю библиотеку) — её готовая разметка больше не нужна
    const rm = Library.remove.bind(Library);
    Library.remove = async (id) => { forgetBook(id); Audiobook.forget(id); return rm(id); };
    if (Library.clear) {
      const clr = Library.clear.bind(Library);
      Library.clear = async (...a) => { [...bookCache.keys()].forEach(forgetBook); if (Audiobook.current) Audiobook.forget(Audiobook.current); return clr(...a); };
    }
  }

  // Вставить готовую книгу (built — из buildBook или из кэша) в страницу. Только быстрые шаги, без разбора.
  function showBook(b, meta, built) {
    Audiobook.unload();      // была открыта аудиокнига — пауза, место сохранено
    stop();
    stashBook();
    book = b;
    bookId = meta.id;
    store.set("lastBook", bookId);
    clearAudioCache();
    bookCache.delete(meta.id);
    blobUrls = built.blobUrls;
    if (segs[pick]) segs[pick].node.classList.remove("pick");
    pick = -1; jumpHistory.length = 0; undoBar.hidden = true;
    segs = built.segs; sections = built.sections; groups = built.groups; curSec = 0;
    // название могли переименовать, пока книга лежала в кэше
    segs[0].text = (b.authors.length ? b.authors.join(", ") + ". " : "") + b.title;
    segs[0].node.textContent = b.title;
    sizeSections();
    // постранично в странице нужна только одна часть — её вставит layoutPaged, всю книгу не вставляем
    if (settings.view === "paged") el.reader.replaceChildren(); else attachAll();
    el.tocList.replaceChildren(...built.toc);
    el.btnToc.disabled = false;          // даже без оглавления: там «Найти главы»
    renderTocTools();
    if (Native) Native.Player.setQueue(meta.id, b.title, segs).then(scheduleCoverage, () => {});
    el.empty.hidden = true;
    el.reader.hidden = false;
    el.title.textContent = b.title;
    el.author.textContent = (b.authors.join(", ") || "Автор не указан") + " · " + (b.formatLabel || "");
    document.title = b.title + " — BookReader";
    el.seek.max = Math.max(0, segs.length - 1);
    document.body.classList.toggle("paged", settings.view === "paged");
    if (settings.view === "paged") layoutPaged(0);
    let saved = meta.pos || 0;
    if (meta.segCount && meta.segCount !== segs.length && meta.progress) saved = Math.round(meta.progress * (segs.length - 1));
    cur = 0;
    autoScroll = false;
    sleepLastPos = -1;
    viewAt = -1; viewT = 0; clearTimeout(dwellT);
    setPos(Math.min(saved, segs.length - 1));
    autoScroll = true;
    if (sleep && sleep.chapter) { sleep.atSeg = nextChapterStart(cur); if (sleep.atSeg < 0) sleep.atSeg = segs.length; sleepSync(); }
    if (saved > 0) {
      setTimeout(() => scrollToSeg(cur, "start"), 50);
      toast("Продолжаем с места, где остановились");
    } else window.scrollTo(0, 0);
    renderLibrary();
  }

  function closeBook() {
    Audiobook.unload();
    stop();
    releaseBook();
    book = null; bookId = null; segs = []; sections = []; groups = []; curSec = 0; pick = -1;
    jumpHistory.length = 0; undoBar.hidden = true;
    document.body.classList.remove("paged", "spread");
    el.pager.removeAttribute("style"); el.reader.style.cssText = "";
    store.set("lastBook", null);
    el.reader.innerHTML = ""; el.reader.hidden = true; el.empty.hidden = false;
    el.tocList.innerHTML = ""; el.btnToc.disabled = true; renderTocTools();
    el.title.textContent = "BookReader"; el.author.textContent = "Читалка с озвучкой Silero";
    document.title = "BookReader";
    updateUI();
    renderLibrary();
  }

  const progressToast = (msg) => toast(msg, 8000);

  // добавить файлы в библиотеку; открыть последний успешно добавленный
  // ---------- несколько файлов → одна книга ----------
  // Выбрали несколько файлов (например, по файлу на главу) — спрашиваем: отдельные книги или одна.
  // Одна книга хранится как ZIP без сжатия: при открытии файлы идут по именам (2 раньше 10) и становятся главами.
  const natCompare = new Intl.Collator("ru", { numeric: true, sensitivity: "base" }).compare;
  function assembledName(names) {
    const base = names.map((n) => n.replace(/\.[^.]+$/, ""));
    let pre = base[0] || "";
    for (const b of base) while (pre && !b.startsWith(pre)) pre = pre.slice(0, -1);
    pre = pre.replace(/[\s\d._\-–—()[\]#№]+$/u, "").replace(/(глава|часть|chapter|part|гл)$/iu, "").replace(/[\s._\-–—]+$/u, "");
    return (pre.length >= 3 ? pre : `Сборник из ${names.length} файлов`) + ".zip";
  }
  async function askAssemble(n, audio) {
    return ask("Несколько файлов", `<p>Выбрано файлов: <b>${n}</b>. Это ${audio ? "части одной аудиокниги" : "главы одной книги"} или отдельные книги?</p>
      <p class="set-hint">Одна книга: файлы встанут по порядку имён (2 раньше 10), каждый станет главой${audio ? "" : " в оглавлении"}.</p>`,
      [{ label: "Отдельные книги", value: "sep" }, { label: "Собрать в одну книгу", primary: true, value: "one" }]);
  }
  // [{ name, data: Uint8Array }] → File (ZIP)
  function assembleFiles(list) {
    list = list.slice().sort((a, b) => natCompare(a.name, b.name));
    const used = new Set();
    const files = list.map((f) => {   // одинаковые имена из разных папок — не затираем друг друга
      let nm = f.name, k = 2;
      while (used.has(nm.toLowerCase())) nm = f.name.replace(/(\.[^.]+)?$/, ` (${k++})$1`);
      used.add(nm.toLowerCase());
      return { name: nm, data: f.data };
    });
    return new File([Zip.build(files)], assembledName(list.map((f) => f.name)), { type: "application/zip" });
  }

  async function addFiles(files, openIt = true) {
    files = Array.from(files);
    // аудиокниги (MP3, M4B…, ZIP с ними) — своим путём: хранятся как есть, открываются в плеере
    const parts = await Audiobook.split(files);
    if (parts.audio.length) {
      const shown = await Audiobook.importBrowser(parts.audio, openIt && !parts.rest.length);
      files = parts.rest;
      if (!files.length) return shown;
    }
    if (files.length > 1 && (await askAssemble(files.length)) === "one") {
      toast(`Собираю книгу из ${files.length} файлов…`, 8000);
      const list = [];
      for (const f of files) list.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
      files = [assembleFiles(list)];
    }
    let opened = null, ok = 0;
    for (const [k, file] of files.entries()) {
      try {
        if (files.length > 1) toast(`Добавляю ${k + 1} из ${files.length}: ${file.name}`, 8000);
        else toast("Открываю «" + file.name + "»…", 8000);
        const buf = await file.arrayBuffer();
        const b = await Books.parseBuffer(buf, file.name, progressToast);
        const meta = await Library.add(file, buf, b);
        ok++;
        if (openIt && (files.length === 1 || k === files.length - 1)) opened = { b, meta };
        else releaseUrls(b);
      } catch (e) {
        console.error(e);
        toast(`«${file.name}»: ${e.message}`, 5000);
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    await refreshLibrary();
    const shown = opened ? await requestOpen({ kind: "parsed", b: opened.b, meta: opened.meta }) : false;
    if (files.length > 1) toast(`Добавлено книг: ${ok} из ${files.length}`);
    else if (shown) el.toast.classList.remove("show");
  }
  function releaseUrls(b) { [b.cover, ...b.items.map((i) => i.src)].forEach((u) => u && u.startsWith("blob:") && URL.revokeObjectURL(u)); }

  // ---------- открытие книг: очередь, отмена, защита от опоздавших ответов ----------
  // Быстрые клики А → Б → В: текущее открытие отменяется (AbortController), ждущий запрос заменяется
  // последним, открытия идут строго по одному (никаких параллельных чтений и разборов). Перед вставкой
  // в страницу результат сверяется с номером последнего запроса — опоздавший ответ не применяется.
  let openSeq = 0;          // номер последнего запроса на открытие (RequestId)
  let openCtl = null;       // отмена текущего открытия
  let openNext = null;      // ждущий запрос (всегда только последний)
  let openRunning = false;
  function requestOpen(job) {
    job.seq = ++openSeq;
    if (openCtl) openCtl.abort();
    if (openNext) dropJob(openNext);   // вытеснен новым кликом — не откроется
    return new Promise((resolve) => {
      job.done = resolve;
      openNext = job;
      if (!openRunning) runOpens();
    });
  }
  function dropJob(job) {
    if (job.b) releaseUrls(job.b);
    job.done(false);
  }
  async function runOpens() {
    openRunning = true;
    try {
      while (openNext) {
        const job = openNext;
        openNext = null;
        const ctl = openCtl = new AbortController();
        let ok = false;
        try { ok = await doOpen(job, ctl.signal); }
        catch (e) {
          if (job.b) releaseUrls(job.b);
          if (!isAbort(e)) openFailed(job, e);
        } finally {
          if (openCtl === ctl) openCtl = null;
          job.done(ok);
        }
      }
    } finally { openRunning = false; }
  }
  const isCurrentOpen = (job, signal) => job.seq === openSeq && !signal.aborted;

  async function doOpen(job, signal) {
    if (job.kind === "parsed") {                       // только что добавленная книга: файл уже разобран
      const built = await buildBook(job.b, signal);
      if (!isCurrentOpen(job, signal)) throw abortError();
      showBook(job.b, job.meta, built);
      return true;
    }
    const id = job.id;
    job.title = (libCache.find((m) => m.id === id) || {}).title;
    if (id === bookId && !job.force) { closePanels(); return true; }
    flushPos();
    const meta = await Library.get(id);
    checkAbort(signal);
    if (!meta) throw new Error("книги нет в библиотеке — возможно, её удалили");
    job.title = meta.title;
    if (meta.format === "audio") {                      // аудиокнига — экран плеера (текстовая книга остаётся под ним)
      if (!isCurrentOpen(job, signal)) throw abortError();
      closePanels();
      await Audiobook.open(meta);
      return true;
    }
    const hit = bookCache.get(id);
    if (hit) {                                          // недавно открытая: файл не читаем и не разбираем
      if (meta.customMeta) { hit.b.title = meta.title; hit.b.authors = meta.authors || []; }
      if (!isCurrentOpen(job, signal)) throw abortError();
      closePanels();
      showBook(hit.b, meta, hit);
      Library.update(id, { openedAt: Date.now() });
      return true;
    }
    // подпись «Открываю…» — только если открытие заметно долгое
    const slow = setTimeout(() => { if (isCurrentOpen(job, signal)) toast("Открываю «" + meta.title + "»…", 8000); }, 250);
    let b = null, built;
    try {
      const rec = await Library.getFile(id, signal);
      checkAbort(signal);
      if (!rec) throw new Error("файл книги не найден в хранилище — возможно, его удалили");
      await yieldUI();
      checkAbort(signal);
      b = await Books.parseBuffer(rec.data, rec.name, (msg) => { if (isCurrentOpen(job, signal)) progressToast(msg); });
      job.b = b;                                        // при отмене дальше — картинки книги освободятся
      checkAbort(signal);
      if (meta.customMeta) { b.title = meta.title; b.authors = meta.authors || []; }
      if (meta.chapters) Books.applyChapters(b, meta.chapters);   // главы, найденные автоматически (оглавление → «Найти главы»)
      await yieldUI();
      checkAbort(signal);
      built = await buildBook(b, signal);
    } finally { clearTimeout(slow); }
    if (!isCurrentOpen(job, signal)) throw abortError();   // пока строили, выбрали другую книгу
    job.b = null;                                       // книга показана — её картинки теперь у неё
    closePanels();
    showBook(b, meta, built);
    el.toast.classList.remove("show");
    Library.update(id, { openedAt: Date.now() });
    return true;
  }

  // ошибка открытия: понятное сообщение, текущая книга остаётся, а если книги нет — открыта библиотека
  function openFailed(job, e) {
    console.error(e);
    if (job.id) forgetBook(job.id);
    const what = job.title ? `«${job.title}»` : "книгу";
    toast(`Не получилось открыть ${what}: ${netMessage ? netMessage(e) : e.message}`, 5000);
    if (!book) { showSettings(false); openPanel(el.lib); }
  }

  const openFromLibrary = (id) => requestOpen({ kind: "lib", id });

  // ---------- виртуальный список: в DOM только видимые строки (+ запас) ----------
  // Высоты строк меряются после показа; до этого используется оценка. Маленькие списки рисуются целиком.
  function VList(box, { small = 80, overscan = 8, frozen = () => false } = {}) {
    let rows = [];            // [{ html, est }]
    let heights = [];         // измеренные высоты (или оценки)
    let offsets = [0];        // offsets[i] — верх строки i
    let range = [-1, -1];
    let raf = 0;
    const recompute = () => {
      offsets = new Array(rows.length + 1);
      offsets[0] = 0;
      for (let i = 0; i < rows.length; i++) offsets[i + 1] = offsets[i] + heights[i];
    };
    const find = (y) => { // первая строка, нижний край которой ниже y
      let lo = 0, hi = rows.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (offsets[m + 1] <= y) lo = m + 1; else hi = m; }
      return lo;
    };
    function measure(from) {
      let changed = false;
      const kids = box.children;
      for (let k = 1; k < kids.length - 1; k++) {
        const h = kids[k].offsetHeight;
        const i = from + k - 1;
        if (h && Math.abs(h - heights[i]) > 0.5) { heights[i] = h; changed = true; }
      }
      if (changed) {
        recompute();
        kids[0].style.height = offsets[from] + "px";
        kids[kids.length - 1].style.height = (offsets[rows.length] - offsets[range[1]]) + "px";
      }
    }
    function draw(force) {
      if (rows.length <= small) {
        if (force) { box.innerHTML = rows.map((r) => r.html).join(""); range = [0, rows.length]; }
        return;
      }
      const top = box.scrollTop, vh = box.clientHeight || 600;
      const a = Math.max(0, find(top) - overscan);
      const b = Math.min(rows.length, find(top + vh) + 1 + overscan);
      if (!force && a === range[0] && b === range[1]) return;
      range = [a, b];
      let html = `<div class="vl-pad" style="height:${offsets[a]}px"></div>`;
      for (let i = a; i < b; i++) html += rows[i].html;
      box.innerHTML = html + `<div class="vl-pad" style="height:${offsets[rows.length] - offsets[b]}px"></div>`;
      measure(a);
    }
    box.addEventListener("scroll", () => {
      if (raf || rows.length <= small) return;
      raf = requestAnimationFrame(() => { raf = 0; if (!frozen()) draw(false); });
    }, { passive: true });
    return {
      set(newRows, { keepScroll = true } = {}) {
        // известные высоты сохраняем по ключу (книга/папка), чтобы прокрутка не прыгала
        const old = new Map(rows.map((r, i) => [r.key, heights[i]]));
        rows = newRows;
        heights = rows.map((r) => old.get(r.key) || r.est);
        recompute();
        if (!keepScroll) box.scrollTop = 0;
        draw(true);
      },
      scrollTo(i) {
        if (i < 0 || i >= rows.length) return;
        if (rows.length > small) { box.scrollTop = Math.max(0, offsets[i] - 40); draw(true); }
        const el = box.querySelector(`[data-vi="${i}"]`);
        if (el) el.scrollIntoView({ block: "nearest" });
      },
      get count() { return rows.length; },
    };
  }
  const debounce = (fn, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ---------- библиотека ----------
  let libCache = [];
  let audioRows = [];   // скачанная озвучка (приложение): [{ bookId, voice, total, done, bytes, running, queued, jobDone, jobTotal, error }]
  async function refreshLibrary() {
    try { libCache = await Library.list(); } catch (_) { libCache = []; }
    renderLibrary();
    renderUsage();
  }

  const fmtSize = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1).replace(".0", "") + " ГБ"
    : n > 1048576 ? (n / 1048576).toFixed(1) + " МБ" : Math.max(1, Math.round(n / 1024)) + " КБ");
  const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function sortedBooks() {
    const q = el.libSearch.value.trim().toLowerCase();
    const by = el.libSort.value;
    const kind = libCache.some((m) => m.format === "audio") ? el.libKind.value : "all";
    let list = libCache.filter((m) => (kind === "all" || (kind === "audio") === (m.format === "audio")) &&
      (!q || (m.title + " " + (m.authors || []).join(" ") + " " + m.name).toLowerCase().includes(q)));
    const coll = new Intl.Collator("ru");
    if (by === "title") list.sort((a, b) => coll.compare(a.title, b.title));
    else if (by === "author") list.sort((a, b) => coll.compare((a.authors || [])[0] || "яя", (b.authors || [])[0] || "яя") || coll.compare(a.title, b.title));
    else if (by === "added") list.sort((a, b) => b.addedAt - a.addedAt);
    else if (by === "progress") list.sort((a, b) => (b.progress || 0) - (a.progress || 0));
    else list.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
    // избранные (звёздочка) — выше остальных, внутри — тем же порядком (сортировка устойчивая)
    list.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));
    return list;
  }

  function coverHtml(m) {
    if (m.cover) return `<img src="${m.cover}" alt="">`;
    const letter = esc((m.title || "?").trim()[0] || "?");
    const hue = [...(m.title || "")].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
    return `<div class="ph" style="--h:${hue}"><b>${letter}</b><small>${esc(m.formatLabel || "")}</small></div>`;
  }

  function bookCard(m) {
    const pct = Math.round((m.progress || 0) * 100);
    const authors = (m.authors || []).join(", ");
    const isAudio = m.format === "audio";
    const len = isAudio && m.audio && m.audio.duration ? AudioMeta.fmtDuration(m.audio.duration) + " · " : "";
    return `<div class="lib-item${m.id === bookId || m.id === Audiobook.current ? " current" : ""}${selected.has(m.id) ? " sel" : ""}" data-id="${m.id}">
      <span class="lib-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <button class="lib-open" data-act="open" title="${isAudio ? "Слушать" : "Открыть"}">
        <span class="lib-cover">${coverHtml(m)}</span>
        <span class="lib-info">
          <span class="lib-title">${esc(m.title)}</span>
          <span class="lib-author">${esc(authors || "Автор не указан")}</span>
          <span class="lib-meta">${isAudio ? '<svg class="lib-ab" aria-label="Аудиокнига"><use href="#i-voice"/></svg>' : ""}<span class="badge">${esc(m.formatLabel || m.format || "")}</span><span class="lib-sz">${len}${fmtSize(m.size || 0)}</span><span class="lib-pct">${pct ? " · " + pct + "%" : " · не начата"}</span></span>
          <span class="lib-progress"><i style="width:${pct}%"></i></span>
          ${Native && modeAllows("tts") && !isAudio ? audioBadge(m.id) : ""}
        </span>
      </button>
      <button class="icon-btn lib-more" data-act="menu" title="Действия" aria-label="Действия">⋯</button>
      <button class="icon-btn lib-fav${m.favorite ? " on" : ""}" data-act="fav" aria-pressed="${m.favorite ? "true" : "false"}"
        title="${m.favorite ? "Убрать из избранного" : "В избранное"}" aria-label="${m.favorite ? "Убрать из избранного" : "В избранное"}"><svg><use href="#i-star"/></svg></button>
    </div>`;
  }

  // список книг: виртуальный (тысячи книг не тормозят); пока открыто меню книги — не перерисовываем
  const libVL = VList(el.libList);
  function renderLibrary() {
    const list = sortedBooks();
    if (!selecting && !el.libView.hidden) libTitle();
    if (list.length) libVL.set(list.map((m, i) => ({ key: m.id, est: 92, html: bookCard(m).replace('<div class="lib-item', `<div data-vi="${i}" class="lib-item`) })));
    else {
      libVL.set([]);
      el.libList.innerHTML = `<div class="lib-empty">${libCache.length ? "Ничего не найдено" : "Библиотека пуста.<br>Добавьте книги кнопкой «Добавить» или перетащите файлы в окно."}</div>`;
    }
    renderHome();
  }

  // ---------- стартовый экран: последняя книга, избранные, недавние ----------
  const tile = (m) => `<button class="recent-item" data-id="${m.id}" title="${esc(m.title)}">
      <span class="lib-cover">${coverHtml(m)}</span><span class="r-title">${esc(m.title)}</span>
      <span class="r-meta">${m.format === "audio" ? '<svg class="lib-ab"><use href="#i-voice"/></svg>' : ""}${esc(m.formatLabel || "")} · ${Math.round((m.progress || 0) * 100)}%</span></button>`;
  function renderHome() {
    const byOpened = [...libCache].sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
    const last = byOpened[0];
    const homeLast = $("homeLast"), homeFav = $("homeFav"), homeEmpty = $("homeEmpty");
    homeEmpty.hidden = !!libCache.length;
    homeLast.hidden = !last;
    if (last) {
      const pct = Math.round((last.progress || 0) * 100);
      const audio = last.format === "audio";
      const left = audio && last.audio && last.audio.duration ? ` · осталось ${AudioMeta.fmtDuration(Math.max(0, last.audio.duration - (last.apos || 0)))}` : "";
      homeLast.innerHTML = `<button class="home-card" data-id="${last.id}">
        <span class="lib-cover">${coverHtml(last)}</span>
        <span class="home-info">
          <span class="home-label">${pct ? (audio ? "Продолжить слушать" : "Продолжить чтение") : (audio ? "Начать слушать" : "Начать чтение")}</span>
          <span class="home-title">${esc(last.title)}</span>
          <span class="home-author">${esc((last.authors || []).join(", ") || "Автор не указан")}</span>
          <span class="home-meta">${audio ? '<svg class="lib-ab"><use href="#i-voice"/></svg>' : ""}${esc(last.formatLabel || "")} · ${pct}%${left}</span>
          <span class="lib-progress"><i style="width:${pct}%"></i></span>
        </span></button>`;
    }
    const favs = byOpened.filter((m) => m.favorite);
    homeFav.hidden = !favs.length;
    $("favList").innerHTML = favs.map(tile).join("");
    const recent = byOpened.slice(1, 11);   // последняя — в карточке сверху
    el.recent.hidden = !recent.length;
    el.recentList.innerHTML = recent.map(tile).join("");
    el.btnHome.hidden = !el.libView.hidden ? (!book && !Audiobook.active) : true;
  }

  // на стартовый экран: книга закрывается (место сохранено), чтение и аудиокнига — на паузу
  function goHome() {
    flushPos();
    closePanels();
    closeBook();
    window.scrollTo(0, 0);
  }

  function updateLibProgress(id, progress) {
    const item = el.libList.querySelector(`.lib-item[data-id="${id}"]`);
    if (!item) return;
    const pct = Math.round(progress * 100);
    item.querySelector(".lib-progress i").style.width = pct + "%";
    item.querySelector(".lib-pct").textContent = pct ? " · " + pct + "%" : " · не начата";
  }

  async function renderUsage() {
    const est = await Library.estimate();
    const total = libCache.reduce((s, m) => s + (m.size || 0), 0);
    let persisted = false;
    try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (_) {}
    el.libUsage.textContent = libCache.length
      ? `Книги: ${fmtSize(total)}` + (est && est.quota ? ` · доступно ещё ~${fmtSize(Math.max(0, est.quota - est.usage))}` : "")
      : "";
    if (Native) {
      let audioBytes = 0;
      try { audioBytes = await Native.Audio.bytes(); } catch (_) {}
      el.libUsage.textContent = libCache.length ? `Книги: ${fmtSize(total)}` + (audioBytes ? ` · озвучка: ${fmtSize(audioBytes)}` : "") + " · на этом устройстве" : "";
      el.libUsage.title = "Книги лежат в памяти приложения (SQLite + файлы) и никуда не синхронизируются.";
      return;
    }
    el.libUsage.title = (est && est.quota ? `Лимит браузера для этой читалки: ${fmtSize(est.quota)}, занято всего: ${fmtSize(est.usage)}.\n` : "") +
      (persisted ? "Хранилище защищено: браузер не удалит книги сам при нехватке места на диске."
                 : "Хранилище не защищено: при нехватке места на диске браузер может очистить данные сайта.");
  }

  el.libList.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const item = btn.closest(".lib-item");
    const id = item.dataset.id;
    const meta = libCache.find((m) => m.id === id);
    switch (btn.dataset.act) {
      case "open":
        if (selecting) { toggleSelected(id, item); return; }
        return openFromLibrary(id);
      case "audio":
        if (id !== bookId) await openFromLibrary(id);
        if (id === bookId) { closePanels(); openDl(); }
        return;
      case "fav": {
        if (!meta) return;
        const on = !meta.favorite;
        try { await Library.update(id, { favorite: on }); } catch (err) { toast("Не получилось: " + err.message, 3500); return; }
        meta.favorite = on;
        renderLibrary();   // виртуальный список хранит разметку строк; избранные поднимаются наверх
        toast(on ? "Добавлено в избранное" : "Убрано из избранного", 1800);
        return;
      }
      case "menu": if (meta) bookMenu(meta); return;
    }
  });

  // ---------- меню книги «⋯»: компактный список, как в «Произношении»; подтверждения и правка — в окне ----------
  async function bookMenu(meta) {
    const id = meta.id, isAudio = meta.format === "audio";
    const info = esc(((meta.authors || []).join(", ") || "Автор не указан") + " · " + (meta.formatLabel || "") + " · " + fmtSize(meta.size || 0));
    const act = await menuDialog(meta.title, info, [
      ...(Native && modeAllows("tts") && !isAudio ? [{ label: "Озвучка без интернета…", value: "audio" }] : []),
      { label: "Переименовать…", value: "rename" },
      { label: Native ? "Поделиться файлом книги" : "Сохранить файл книги", value: "export" },
      { label: "Сбросить прогресс…", value: "reset" },
      { label: "Удалить…", value: "delete", danger: true },
    ]);
    if (act === "audio") {
      if (id !== bookId) await openFromLibrary(id);
      if (id === bookId) { closePanels(); openDl(); }
    } else if (act === "rename") renameBook(meta);
    else if (act === "export") exportBook(id);
    else if (act === "reset") {
      const ok = await ask("Сбросить прогресс?", `<p>${isAudio ? "Прослушивание" : "Чтение"} «${esc(meta.title)}» начнётся с начала книги.</p>`,
        [{ label: "Отмена", value: null }, { label: "Сбросить", primary: true, danger: true, value: 1 }]);
      if (!ok) return;
      await Library.update(id, isAudio ? { apos: 0, progress: 0 } : { pos: 0, progress: 0 });
      Object.assign(meta, { pos: 0, progress: 0, apos: 0 });
      if (id === bookId) jump(0, false);
      Audiobook.reset(id);
      renderLibrary();
      toast("Прогресс сброшен");
    } else if (act === "delete") {
      const ok = await ask("Удалить книгу?", `<p>«${esc(meta.title)}» удалится из библиотеки${Native && !isAudio ? " вместе с загруженной озвучкой" : ""}. Отменить нельзя.</p>`,
        [{ label: "Отмена", value: null }, { label: "Удалить", primary: true, danger: true, value: 1 }]);
      if (!ok) return;
      await Library.remove(id);
      if (id === bookId) closeBook();
      await refreshLibrary();
      toast("Книга удалена");
    }
  }
  async function renameBook(meta) {
    const id = meta.id;
    const v = await ask("Переименовать", `<label class="set-field"><span>Название</span><input class="in-title" value="${esc(meta.title)}"></label>
      <label class="set-field"><span>Автор</span><input class="in-author" value="${esc((meta.authors || []).join(", "))}"></label>`,
      [{ label: "Отмена", value: null }, { label: "Сохранить", primary: true, value: 1 }], { top: true });
    if (!v) return;
    const title = askEl.body.querySelector(".in-title").value.trim() || meta.title;
    const authors = askEl.body.querySelector(".in-author").value.split(",").map((x) => x.trim()).filter(Boolean);
    await Library.update(id, { title, authors, customMeta: true });
    Object.assign(meta, { title, authors });
    Audiobook.rename(id, title, authors);
    if (id === bookId && book) {
      book.title = title; book.authors = authors;
      el.title.textContent = title;
      el.author.textContent = (authors.join(", ") || "Автор не указан") + " · " + (book.formatLabel || "");
    }
    renderLibrary();
    toast("Сохранено");
  }
  async function exportBook(id) {
    if (Native) {
      try { await Native.exportBook(id); } catch (e) { toast("Не получилось: " + e.message, 4000); }
      return;
    }
    const rec = await Library.getFile(id);
    if (!rec) return toast("Файл не найден");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([rec.data], { type: rec.type || "application/octet-stream" }));
    a.download = rec.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  // меню «⋯»: заголовок, строка пояснения, пункты; закрыть — ✕, фон, «Назад» (без «Отмены»)
  async function menuDialog(title, info, items) {
    const p = ask(title, `<div class="pr-menu">${info ? `<div class="pr-hint">${info}</div>` : ""}
      ${items.map((it, i) => `<button class="pr-mi${it.danger ? " danger" : ""}" data-i="${i}">${esc(it.label)}</button>`).join("")}</div>`, []);
    askEl.box.classList.add("pr-small");
    askEl.body.querySelectorAll(".pr-mi").forEach((b) => (b.onclick = () => { if (askDone) askDone(items[Number(b.dataset.i)].value); }));
    const v = await p;
    askEl.box.classList.remove("pr-small");
    return v;
  }

  // ---------- выбор нескольких книг и групповые действия ----------
  let selecting = false;
  const selected = new Set();
  function setSelecting(on) {
    selecting = on;
    if (!on) selected.clear();
    el.lib.classList.toggle("selecting", on);
    el.selBar.hidden = !on;
    el.btnSelect.title = on ? "Закончить выбор" : "Выбрать несколько";
    if (!on && !el.libView.hidden) libTitle();
    renderLibrary();
    updateSelBar();
  }
  function toggleSelected(id, item) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    if (item) item.classList.toggle("sel", selected.has(id));
    updateSelBar();
  }
  // заголовок панели: «Библиотека N» или, в режиме выбора, «Выбрано: N» (в панели внизу ему не хватает места)
  // когда есть аудиокниги, заголовок — выбор «Библиотека / Книги / Аудиокниги» (без лишней строки в панели)
  function libTitle() {
    if (selecting) { el.libHeadTitle.textContent = `Выбрано: ${selected.size}`; el.libKind.hidden = true; return; }
    const hasAudio = libCache.some((m) => m.format === "audio");
    const kind = hasAudio ? el.libKind.value : "all";
    const n = kind === "all" ? libCache.length : libCache.filter((m) => (m.format === "audio") === (kind === "audio")).length;
    el.libHeadTitle.innerHTML = (hasAudio ? "" : "Библиотека ") + `<span class="count" id="libCount">${n || ""}</span>`;
    if (hasAudio) el.libHeadTitle.prepend(el.libKind);
    el.libKind.hidden = !hasAudio;
    el.libCount = document.getElementById("libCount") || el.libCount;
  }
  function updateSelBar() {
    const n = selected.size;
    if (el.libView && !el.libView.hidden) libTitle();
    const visible = sortedBooks();
    const allOn = visible.length > 0 && visible.every((m) => selected.has(m.id));
    el.selAll.title = allOn ? "Снять выбор" : "Выбрать все";
    el.selAll.querySelector("span").textContent = allOn ? "Снять" : "Все";
    [el.selShare, el.selAudio, el.selDelete].forEach((b) => (b.disabled = !n));
    // озвучка — только для обычных книг: выбраны одни аудиокниги — кнопки нет
    el.selAudio.hidden = n > 0 && [...selected].every((id) => (libCache.find((m) => m.id === id) || {}).format === "audio");
  }
  const selBooks = () => libCache.filter((m) => selected.has(m.id));
  // долгое нажатие на книгу (касание) — включить выбор и отметить её, как в Telegram
  if (window.longPress) window.longPress(el.libList, ".lib-item", (item) => {
    const id = item.dataset.id;
    if (!selecting) setSelecting(true);
    toggleSelected(id, [...el.libList.querySelectorAll(".lib-item")].find((x) => x.dataset.id === id));
  }, ".lib-more, .lib-fav");
  el.btnSelect.onclick = () => setSelecting(!selecting);
  $("selCancel").onclick = () => setSelecting(false);
  el.selAll.onclick = () => {
    const visible = sortedBooks(); // «все» — с учётом поиска
    const allOn = visible.every((m) => selected.has(m.id));
    visible.forEach((m) => (allOn ? selected.delete(m.id) : selected.add(m.id)));
    renderLibrary();
    updateSelBar();
  };
  el.selShare.onclick = async () => {
    const list = selBooks();
    if (!list.length) return;
    if (Native) {
      try { await Native.exportBooks(list.map((m) => m.id)); } catch (e) { toast("Не получилось: " + e.message, 4000); }
      return;
    }
    // браузер: сохраняем файлы по очереди
    for (const m of list) {
      const rec = await Library.getFile(m.id);
      if (!rec) continue;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([rec.data], { type: rec.type || "application/octet-stream" }));
      a.download = rec.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      await new Promise((r) => setTimeout(r, 400));
    }
  };
  el.selAudio.onclick = () => groupAudio();
  el.selDelete.onclick = async () => {
    const list = selBooks();
    if (!list.length) return;
    const names = list.slice(0, 5).map((m) => `<li>${esc(m.title)}</li>`).join("") + (list.length > 5 ? `<li>…и ещё ${list.length - 5}</li>` : "");
    const ok = await ask("Удалить книги?",
      `<p>Удалить из библиотеки ${list.length} ${plural(list.length, "книгу", "книги", "книг")}?${Native ? " Их загруженная озвучка тоже удалится." : ""}</p><ul>${names}</ul>`,
      [{ label: "Отмена", value: null }, { label: `Удалить (${list.length})`, primary: true, danger: true, value: "yes" }]);
    if (ok !== "yes") return;
    for (const m of list) {
      await Library.remove(m.id);
      if (m.id === bookId) closeBook();
    }
    setSelecting(false);
    await refreshLibrary();
    toast(`Удалено книг: ${list.length}`);
  };

  // поиск — после паузы в наборе: быстрый ввод/стирание не создаёт очередь перерисовок
  el.libSearch.oninput = debounce(() => { renderLibrary(); el.libList.scrollTop = 0; if (selecting) updateSelBar(); }, 150);
  el.libSort.value = store.get("libSort", "recent");
  if (!el.libSort.value) el.libSort.value = "recent";   // сохранённый пункт, которого больше нет
  el.libSort.onchange = () => { store.set("libSort", el.libSort.value); renderLibrary(); };
  el.libKind.value = store.get("libKind", "all");
  if (!el.libKind.value) el.libKind.value = "all";
  el.libKind.onchange = () => { store.set("libKind", el.libKind.value); renderLibrary(); el.libList.scrollTop = 0; if (selecting) updateSelBar(); };
  // в приложении книги выбираются системным диалогом (на Android поле выбора файла в WebView ненадёжно)
  async function nativePick() {
    let picked;
    try { picked = await Library.pickFiles(); } catch (e) { return toast("Не удалось выбрать файлы: " + e.message); }
    if (!picked.length) return;
    // аудиокниги: приложение уже положило файлы; разбираем куски файла, не читая его целиком
    const audioPicked = [];
    for (const p of picked) {
      if (AudioMeta.isAudioName(p.name)) { audioPicked.push(p); continue; }
      if (AudioMeta.ext(p.name) === "zip") { try { if (await AudioMeta.zipIsAudio(await Library.reader(p.id))) audioPicked.push(p); } catch (_) {} }
    }
    if (audioPicked.length) {
      picked = picked.filter((p) => !audioPicked.includes(p));
      const id = await Audiobook.importNative(audioPicked);
      if (!picked.length) { if (id) openFromLibrary(id); return; }
    }
    if (picked.length > 1 && (await askAssemble(picked.length)) === "one") {
      // приложение уже положило файлы в библиотеку по одному — собираем из них одну книгу, отдельные убираем
      try {
        const list = [];
        for (const [k, p] of picked.entries()) {
          if (k % 20 === 0) toast(`Собираю книгу: ${k + 1} из ${picked.length}…`, 8000);
          const rec = await Library.getFile(p.id);
          if (rec) list.push({ name: p.name || rec.name, data: new Uint8Array(rec.data) });
        }
        const file = assembleFiles(list);
        const buf = await file.arrayBuffer();
        const b = await Books.parseBuffer(buf, file.name, progressToast);
        const meta = await Library.add(file, buf, b);
        releaseUrls(b);
        for (const p of picked) if (p.isNew && p.id !== meta.id) await Library.remove(p.id).catch(() => {});
        await refreshLibrary();
        return openFromLibrary(meta.id);
      } catch (e) { toast("Не получилось собрать книгу: " + e.message, 5000); }
    }
    const lastId = await importNative(picked);
    if (lastId) openFromLibrary(lastId);
  }
  // книги, которые C# уже положил в библиотеку: новые разбираем (название, автор, обложка)
  async function importNative(picked) {
    let lastId = null, ok = 0;
    for (const [k, p] of picked.entries()) {
      try {
        if (p.isNew) {
          toast(picked.length > 1 ? `Добавляю ${k + 1} из ${picked.length}: ${p.name}` : `Открываю «${p.name}»…`, 8000);
          const rec = await Library.getFile(p.id);
          const b = await Books.parseBuffer(rec.data, rec.name, progressToast);
          await Library.update(p.id, { title: b.title, authors: b.authors, format: b.format, formatLabel: b.formatLabel, cover: await Library.thumbnail(b.cover) });
          releaseUrls(b);
        }
        lastId = p.id; ok++;
      } catch (e) {
        console.error(e);
        await Library.remove(p.id).catch(() => {});
        toast(`«${p.name}»: ${e.message}`, 5000);
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    await refreshLibrary();
    if (picked.length > 1) toast(`Добавлено книг: ${ok} из ${picked.length}`);
    return lastId;
  }
  if (Native) {
    document.querySelector(".btn-add").addEventListener("click", (e) => { e.preventDefault(); nativePick(); });
  }

  el.libFiles.onchange = () => { if (el.libFiles.files.length) addFiles(el.libFiles.files); el.libFiles.value = ""; };
  el.empty.addEventListener("click", (e) => {
    const b = e.target.closest(".recent-item, .home-card");
    if (b) openFromLibrary(b.dataset.id);
  });
  el.btnHome.onclick = () => goHome();
  $("homeOpenLib").onclick = () => { showSettings(false); openPanel(el.lib); };


  // ---------- озвучка без интернета (только приложение) ----------
  // выбрать голос в списке; если его там нет (сервер недоступен, старый ответ) — добавить
  function pickVoice(v) {
    if (![...el.voice.options].some((o) => o.value === v)) el.voice.add(new Option(voiceName(v), v));
    el.voice.value = v;
  }
  const voiceName = (v) => {
    const o = [...el.voice.options].find((x) => x.value === v);
    if (o) return o.textContent.replace(/\s*\(.*\)$/, "").replace(/\s+—.*$/, "");
    // голоса нет в списке (сервер недоступен / старый) — известные имена Silero
    return { aidar: "Айдар", eugene: "Евгений", baya: "Байя", xenia: "Ксения", kseniya: "Ксюша" }[v] || v;
  };
  const rowsOf = (id) => audioRows.filter((r) => r.bookId === id);
  function mainRow(id) {
    const rows = rowsOf(id);
    if (!rows.length) return null;
    return rows.find((r) => r.running) || rows.find((r) => r.queued) ||
      [...rows].sort((a, b) => (b.total ? b.done / b.total : 0) - (a.total ? a.done / a.total : 0))[0];
  }
  function audioBadge(id) {
    const r = mainRow(id);
    let cls = "net", icon = "i-cloud", text = "Озвучка с сервера", title = "Озвучка не загружена: для чтения вслух нужен сервер на ПК";
    if (r) {
      const pct = r.total ? Math.floor((r.done / r.total) * 100) : 0;
      const name = `Озвучка — ${voiceName(r.voice)}`;
      if (r.running && r.paused) { cls = "err"; icon = "i-pause"; text = `Нет связи · ${pct}% · ${name}`; title = "Загрузка на паузе: нет связи с сервером"; }
      else if (r.running) { cls = "run"; icon = "i-dl"; text = `Загружается ${pct}% · ${name}`; title = "Идёт загрузка озвучки"; }
      else if (r.queued) { cls = "run"; icon = "i-dl"; text = `В очереди · ${name}`; title = "Ждёт загрузки"; }
      else if (r.total && r.done >= r.total) { cls = "ok"; icon = ""; text = `✓ Загружено 100% · ${name}`; title = "Озвучка загружена целиком: сервер не нужен"; }
      else if (r.done) { cls = "part"; icon = ""; text = `◐ Загружено ${pct}% · ${name}`; title = "Загружена часть: остальное — с сервера"; }
      if (r.error && !r.running) { cls = "err"; icon = ""; text = `⚠ ${pct ? pct + "% · " : ""}ошибка загрузки`; title = r.error; }
      const upd = (r.stale || 0) + (r.unknown || 0);
      if (typeof r.checking === "number") { text += ` · ↻ проверка ${r.checking}%`; title += ". Идёт проверка: не изменилось ли звучание после правок"; }
      else if (upd && !r.running) { text += " · ↻"; title += `. Ожидает обновления фраз: ${upd} — «Озвучка без интернета»`; }
      const more = rowsOf(id).filter((x) => x !== r && (x.done > 0 || x.running || x.queued)).length;
      if (more) { text += ` +${more}`; title += `. Других озвучек: ${more} — список в окне «Озвучка без интернета»`; }
    }
    return `<span class="lib-audio ${cls}" title="${esc(title)}">${icon ? `<svg><use href="#${icon}"/></svg>` : ""}${esc(text)}</span>`;
  }
  function updateAudioBadge(id) {
    const item = el.libList.querySelector(`.lib-item[data-id="${id}"] .lib-audio`);
    if (item) item.outerHTML = audioBadge(id);
  }
  async function refreshAudio() {
    if (!Native) return;
    try { audioRows = await Native.Audio.status(); } catch (_) { audioRows = []; }
    renderLibrary();
    if (!el.dl.hidden) updateDl();
  }

  // главы открытой книги: [{ title, seg }]
  function chapters() {
    const list = [];
    for (let i = 0; i < segs.length; i++) if (segs[i].toc) list.push({ title: segs[i].toc, seg: i });
    return list;
  }
  function dlRangeSegs() {
    const mode = el.dl.querySelector('input[name="dlMode"]:checked').value;
    const ch = chapters();
    if (mode !== "ch" || !ch.length) return [0, segs.length];
    let f = Number(el.dlFrom.value), t = Number(el.dlTo.value);
    if (t < f) [f, t] = [t, f];
    return [f === 0 ? 0 : ch[f].seg, t + 1 < ch.length ? ch[t + 1].seg : segs.length];
  }
  const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  const fmtHours = (h) => (h < 1 ? Math.max(1, Math.round(h * 60)) + " мин" : h.toFixed(1).replace(".", ",").replace(",0", "") + " ч");

  function openDl() {
    if (!Native || !book || !segs.length) return toast("Сначала откройте книгу");
    el.dlBook.innerHTML = `${esc(book.title)}<small>${esc(book.authors.join(", ") || "")}</small>`;
    el.dlVoice.innerHTML = el.voice.innerHTML;
    el.dlVoice.value = el.voice.value;
    const ch = chapters();
    el.dlModeCh.hidden = !ch.length;
    const opts = ch.map((c, k) => `<option value="${k}">${esc(String(k + 1) + ". " + (c.title.length > 60 ? c.title.slice(0, 60) + "…" : c.title))}</option>`).join("");
    el.dlFrom.innerHTML = opts; el.dlTo.innerHTML = opts;
    if (ch.length) {
      let curCh = 0;
      ch.forEach((c, k) => { if (c.seg <= cur) curCh = k; });
      el.dlFrom.value = String(curCh);
      el.dlTo.value = String(ch.length - 1);
    }
    el.dl.querySelector('input[name="dlMode"][value="all"]').checked = true;
    el.dlRange.hidden = true;
    el.dl.hidden = false;
    el.dlChapters.hidden = true;
    updateDl();
    refreshAudio();
    refreshCoverage();
  }
  function closeDl() { el.dl.hidden = true; }

  function updateDl() {
    if (el.dl.hidden || !book) return;
    const [a, b] = dlRangeSegs();
    let chars = 0;
    for (let i = a; i < b; i++) chars += segs[i].text.length;
    const hours = chars / 1000 / 60;                    // ~1000 символов в минуту
    const mb = hours * 14.4;                            // Opus 32 кбит/с
    const n = b - a;
    el.dlEst.textContent = `${n.toLocaleString("ru")} ${plural(n, "фраза", "фразы", "фраз")} · около ${fmtHours(hours)} звука · ~${mb < 10 ? mb.toFixed(1).replace(".", ",") : Math.round(mb)} МБ`;

    const voice = el.dlVoice.value;
    const r = rowsOf(bookId).find((x) => x.voice === voice);
    const running = !!(r && (r.running || r.queued));
    const pct = r && r.total ? Math.floor((r.done / r.total) * 100) : 0;
    const name = `Озвучка — ${voiceName(voice)}`;
    el.dlBar.style.width = pct + "%";
    let text;
    if (!r || (!r.total && !running)) text = `${name}: ещё не загружена — читается с сервера.`;
    else if (r.running && r.paused) text = `⏸ Нет связи с сервером — загрузка на паузе (загружено ${pct}%). Продолжится после восстановления связи.`;
    else if (r.running) {
      const jp = r.jobTotal ? Math.floor((r.jobDone / r.jobTotal) * 100) : 100;
      text = `Загружается ${jp}% выбранного (${r.jobDone} из ${r.jobTotal}). Загружено ${pct}% книги · ${name} · ${fmtSize(r.bytes || 0)}`;
    }
    else if (r.queued) text = `${name}: в очереди, начнётся после текущей загрузки.`;
    else if (r.done >= r.total) text = `✓ Загружено 100% · ${name} (${fmtSize(r.bytes || 0)}) — сервер для чтения не нужен.`;
    else text = `Загружено ${pct}% · ${name} (${r.done} из ${r.total} фраз, ${fmtSize(r.bytes || 0)}). Остальное — с сервера.`;
    if (r && r.error) text += ` ⚠ ${r.error}`;
    // качается другой голос этой книги — показать и его прогресс
    const other = rowsOf(bookId).find((x) => x.voice !== voice && (x.running || x.queued));
    if (other) {
      const jp = other.jobTotal ? Math.floor((other.jobDone / other.jobTotal) * 100) : 0;
      text += other.running
        ? ` Сейчас загружается: Озвучка — ${voiceName(other.voice)}, ${jp}% выбранного (${other.jobDone} из ${other.jobTotal})${other.paused ? ", пауза: нет связи" : ""}.`
        : ` В очереди: Озвучка — ${voiceName(other.voice)}.`;
    }
    if (offlineMode) text = "Включён режим «Без сервера»: загружать не с чего. " + text;
    el.dlText.textContent = text;
    updateRefresh(r);
    el.dlListen.hidden = !running && !(r && r.done);
    el.dlStart.hidden = running;
    el.dlStart.querySelector("span").textContent = r && r.done > 0 && r.done < r.total ? "Продолжить" : "Скачать";
    el.dlStart.disabled = offlineMode;
    // «Остановить» — если у книги идёт или ждёт любая загрузка (другим голосом, из общей очереди — тоже)
    el.dlStop.hidden = !rowsOf(bookId).some((x) => x.running || x.queued);
    el.dlDelete.hidden = true; // удаление — у каждой озвучки в списке ниже
    renderPacks();
  }

  // скачанная озвучка ждёт обновления (шаг 5): изменились правила / нормализатор сервера, или скачана до 1.2.0.
  // Обновление — только по кнопке; до него и во время него старые фразы слушаются как раньше.
  function updateRefresh(r) {
    const box = $("dlUpd");
    const stale = (r && r.stale) || 0, unknown = (r && r.unknown) || 0;
    const checking = r && typeof r.checking === "number" ? r.checking : -1;
    if (checking >= 0) {
      // сверка идёт (на большой книге — секунды): показать, чтобы не решили, что изменений нет
      box.hidden = false;
      box.querySelector(".dl-upd-text").innerHTML = `<p><b>↻ Проверяю, не изменилось ли звучание после правок… ${checking}%</b></p>
        <p class="dl-upd-hint">Фразы озвучки сравниваются с текущими правилами произношения и версией сервера. Можно закрыть окно — проверка идёт в фоне.</p>`;
      $("dlRefresh").hidden = true;
      return;
    }
    $("dlRefresh").hidden = false;
    box.hidden = !r || r.running || r.queued || !(stale + unknown);
    if (box.hidden) return;
    const n = (k) => `${k.toLocaleString("ru")} ${plural(k, "фраза", "фразы", "фраз")}`;
    const parts = [];
    if (stale) parts.push(`<p><b>↻ Ожидает обновления: ${n(stale)}.</b> С тех пор, как они скачаны, изменились правила
      произношения этой книги или обновился сервер — сейчас они прозвучали бы иначе.</p>`);
    if (unknown) parts.push(`<p><b>↻ Скачано до версии 1.2.0: ${n(unknown)}.</b> Эта озвучка не знает о правилах
      произношения и улучшениях чтения чисел и сокращений, и проверить её нельзя — её можно только синтезировать заново.</p>`);
    parts.push(`<p class="dl-upd-hint">Пока не обновлено, слушается прежний вариант. «Обновить» скачает заново только эти фразы;
      пока новая фраза не пришла (или пропала связь), звучит старая.</p>`);
    box.querySelector(".dl-upd-text").innerHTML = parts.join("");
    $("dlRefresh").disabled = offlineMode;
    box.dataset.unknown = String(unknown);
    box.dataset.total = String(stale + unknown);
  }
  $("dlRefresh").onclick = async () => {
    const box = $("dlUpd"), voice = el.dlVoice.value;
    const unknown = Number(box.dataset.unknown || 0), total = Number(box.dataset.total || 0);
    if (unknown) {
      // старую озвучку обновляем только по явному согласию: она будет синтезирована заново
      const ok = await ask("Обновить озвучку?",
        `<p>${total.toLocaleString("ru")} ${plural(total, "фраза", "фразы", "фраз")} будут синтезированы заново
        с текущими правилами произношения. Это займёт время и место на сервере, как первая загрузка.</p>
        <p>Можно не обновлять — тогда слушается старый вариант.</p>`,
        [{ label: "Нет, оставить", value: null }, { label: "Да, обновить", primary: true, value: 1 }]);
      if (!ok) return;
    }
    try {
      const started = await Native.Audio.refresh(bookId, book.title, voice);
      toast(started ? "Обновление озвучки началось — старые фразы заменяются по мере загрузки" : "Обновлять нечего", 3500);
    } catch (e) { toast("Не получилось: " + netMessage(e), 5000); }
    refreshAudio();
  };

  // все озвучки этой книги: голос, сколько загружено, место; слушать / удалить
  function renderPacks() {
    const box = el.dlPacks;
    const rows = rowsOf(bookId).filter((r) => r.done > 0 || r.running || r.queued)
      .sort((a, b) => (b.done / (b.total || 1)) - (a.done / (a.total || 1)));
    box.hidden = !rows.length;
    if (!rows.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="dl-packs-head">Озвучки этой книги (${rows.length})</div>` + rows.map((r) => {
      const pct = r.total ? Math.floor((r.done / r.total) * 100) : 0;
      const upd = (r.stale || 0) + (r.unknown || 0);
      const jp = r.jobTotal ? Math.floor((r.jobDone / r.jobTotal) * 100) : 0;
      const st = r.running ? `загружается ${jp}% выбранного (${r.jobDone} из ${r.jobTotal})` : r.queued ? "в очереди"
        : typeof r.checking === "number" ? `↻ проверка ${r.checking}%` : r.error ? "⚠ остановлена"
        : upd ? `↻ ожидает обновления: ${upd}` : pct >= 100 ? "✓" : "";
      const isCur = r.voice === el.voice.value;
      return `<div class="dl-pack${isCur ? " cur" : ""}${r.voice === el.dlVoice.value ? " picked" : ""}" data-voice="${esc(r.voice)}">
        <div class="dl-pack-info" data-pact="pick" title="Выбрать эту озвучку"><b>Озвучка — ${esc(voiceName(r.voice))}</b>${isCur ? ' <span class="dl-pack-tag">сейчас</span>' : ""}
          <small>Загружено ${pct}% · ${fmtSize(r.bytes || 0)}${st ? " · " + st : ""}</small></div>
        <button class="dl-pack-btn" data-pact="listen" title="Слушать этой озвучкой">▶</button>
        ${r.running || r.queued
          ? '<button class="dl-pack-btn" data-pact="stop" title="Остановить загрузку (скачанное останется)">Остановить</button>'
          : '<button class="dl-pack-btn danger" data-pact="del" title="Удалить эту озвучку">Удалить</button>'}
      </div>`;
    }).join("");
  }

  el.btnDl.onclick = () => { closePanels(); openDl(); };
  el.dlClose.onclick = closeDl;
  el.dl.addEventListener("click", (e) => { if (e.target === el.dl) closeDl(); });
  el.dl.querySelectorAll('input[name="dlMode"]').forEach((r) => (r.onchange = () => {
    el.dlRange.hidden = el.dl.querySelector('input[name="dlMode"]:checked').value !== "ch";
    updateDl();
  }));
  el.dlFrom.onchange = () => { if (Number(el.dlTo.value) < Number(el.dlFrom.value)) el.dlTo.value = el.dlFrom.value; updateDl(); };
  el.dlTo.onchange = () => { if (Number(el.dlTo.value) < Number(el.dlFrom.value)) el.dlFrom.value = el.dlTo.value; updateDl(); };
  el.dlVoice.onchange = () => { updateDl(); scheduleCoverage(); };
  el.dlStart.onclick = async () => {
    const [a, b] = dlRangeSegs();
    try {
      await Native.Audio.start(bookId, book.title, el.dlVoice.value, a, b);
      toast("Загрузка озвучки началась — можно читать дальше или свернуть приложение");
    } catch (e) { toast("Не получилось начать: " + netMessage(e), 5000); }
    refreshAudio();
  };
  // слушать сразу: плеер берёт уже скачанное и ждёт следующие фразы из загрузки (не генерирует их второй раз)
  el.dlListen.onclick = () => {
    const v = el.dlVoice.value;
    closeDl();
    rememberVoice(v);
    if (v !== el.voice.value) { pickVoice(v); el.voice.onchange(); }
    playFrom(cur);
  };
  el.dlPacks.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-pact]");
    if (!btn) return;
    const v = btn.closest(".dl-pack").dataset.voice;
    if (btn.dataset.pact === "pick") {
      // выбрать эту озвучку в окне (голос сверху меняется тоже): дальше — «Продолжить», «Обновить», «Слушать»
      if (el.dlVoice.value !== v) { el.dlVoice.value = v; el.dlVoice.onchange(); }
      return;
    }
    if (btn.dataset.pact === "stop") {
      await Native.Audio.cancel(bookId);
      toast("Загрузка остановлена — скачанное сохранено");
      return refreshAudio();
    }
    if (btn.dataset.pact === "listen") {
      closeDl();
      rememberVoice(v);
      if (v !== el.voice.value) { pickVoice(v); el.voice.onchange(); }
      playFrom(cur);
    } else if (btn.dataset.pact === "del") {
      if (btn.dataset.confirm !== "1") { btn.dataset.confirm = "1"; btn.textContent = "Точно удалить?"; return; }
      await Native.Audio.remove(bookId, v);
      toast(`Озвучка — ${voiceName(v)} удалена`);
      await refreshAudio();
      renderUsage();
      scheduleCoverage();
    }
  });
  el.dlStop.onclick = async () => { await Native.Audio.cancel(bookId); refreshAudio(); };
  el.dlDelete.onclick = async () => {
    if (el.dlDelete.dataset.confirm !== "1") {
      el.dlDelete.dataset.confirm = "1";
      el.dlDelete.textContent = "Точно удалить? Нажмите ещё раз";
      return;
    }
    await Native.Audio.remove(bookId, el.dlVoice.value);
    toast("Скачанная озвучка удалена");
    refreshAudio();
    renderUsage();
  };


  // ---------- какие главы озвучены (приложение) ----------
  let covTimer = 0;
  function scheduleCoverage() {
    if (!Native) return;
    clearTimeout(covTimer);
    covTimer = setTimeout(refreshCoverage, 700);
  }
  // [1,2,3,5] → «1–3, 5»
  function spans(nums) {
    const out = [];
    for (let i = 0; i < nums.length; i++) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      out.push(j > i ? `${nums[i]}–${nums[j]}` : String(nums[i]));
      i = j;
    }
    return out.join(", ");
  }
  // список глав в окне загрузки — виртуальный: в DOM только видимые строки (книги на 1000+ глав)
  const ROW_H = 22;
  const covList = { ch: [], cov: [], box: null, from: -1, scroll: 0 };
  function renderCovRows(force) {
    const { box, ch, cov } = covList;
    if (!box) return;
    covList.scroll = box.scrollTop;
    const from = Math.max(0, Math.floor(box.scrollTop / ROW_H) - 6);
    const to = Math.min(ch.length, from + Math.ceil((box.clientHeight || 198) / ROW_H) + 12);
    if (!force && from === covList.from) return;
    covList.from = from;
    let html = "";
    for (let k = from; k < to; k++) {
      const [d, t] = cov[k] || [0, 0];
      const cls = t && d >= t ? "ok" : d ? "part" : "none";
      const mark = cls === "ok" ? "✓" : cls === "part" ? "◐" : "○";
      const pct = cls === "part" ? `${Math.floor((d / t) * 100)}%` : "";
      html += `<div class="dl-ch ${cls}" style="top:${k * ROW_H}px"><b>${mark}</b><span>${k + 1}. ${esc(ch[k].title)}</span><small>${pct}</small></div>`;
    }
    box.querySelector(".dl-ch-pad").innerHTML = html;
  }
  // длинные перечни сокращаем: «1–40, 42, 45 … и ещё 37»
  function spansShort(nums, max = 8) {
    const parts = spans(nums).split(", ");
    return parts.length <= max ? parts.join(", ") : parts.slice(0, max).join(", ") + ` … и ещё ${parts.length - max}`;
  }

  async function refreshCoverage() {
    if (!Native || !book || !segs.length) return;
    const ch = chapters();
    const starts = ch.map((c) => c.seg);
    const forBook = bookId;
    try {
      // оглавление: отметки для голоса, которым сейчас читаем
      const play = starts.length ? await Native.Audio.coverage(bookId, el.voice.value, starts) : [];
      if (forBook !== bookId) return;
      const bySeg = new Map(ch.map((c, k) => [c.seg, play[k]]));
      el.tocList.querySelectorAll("a[data-seg]").forEach((a) => {
        const c = bySeg.get(Number(a.dataset.seg));
        a.classList.toggle("dl-ok", !!(c && c[1] && c[0] >= c[1]));
        a.classList.toggle("dl-part", !!(c && c[0] && c[0] < c[1]));
        a.title = c && c[0] ? (c[0] >= c[1] ? "Озвучка главы загружена" : `Загружено ${Math.floor((c[0] / c[1]) * 100)}% главы`) : "";
      });
      // окно загрузки: список глав для выбранного там голоса
      if (el.dl.hidden || !ch.length) { el.dlChapters.hidden = true; return; }
      const cov = el.dlVoice.value === el.voice.value ? play : await Native.Audio.coverage(bookId, el.dlVoice.value, starts);
      if (forBook !== bookId) return;
      const full = [], part = [], none = [];
      cov.forEach((c, k) => (c[1] && c[0] >= c[1] ? full : c[0] ? part : none).push(k + 1));
      if (!full.length && !part.length) { el.dlChapters.hidden = true; return; }
      let sum;
      if (!none.length && !part.length) sum = "Все главы загружены.";
      else {
        sum = (full.length ? `<b>Загружены главы (${full.length}):</b> ${spansShort(full)}` : "<b>Целиком не загружено ни одной главы</b>") +
          (part.length ? `<br><b>Частично (${part.length}):</b> ${spansShort(part)}` : "") +
          (none.length ? `<br><b>Нужен сервер (${none.length}):</b> ${spansShort(none)}` : "");
      }
      const firstRender = el.dlChapters.hidden || !covList.ch.length;
      el.dlChapters.innerHTML = `<div class="dl-ch-sum">${sum}</div><div class="dl-ch-list"><div class="dl-ch-pad"></div></div>`;
      Object.assign(covList, { ch, cov, box: el.dlChapters.querySelector(".dl-ch-list"), from: -1 });
      covList.box.querySelector(".dl-ch-pad").style.height = ch.length * ROW_H + "px";
      covList.box.onscroll = () => renderCovRows();
      el.dlChapters.hidden = false;
      if (firstRender) {   // сразу к главе, которую сейчас читаем
        let k = 0;
        ch.forEach((c, i) => { if (c.seg <= cur) k = i; });
        covList.box.scrollTop = Math.max(0, (k - 2) * ROW_H);
      } else covList.box.scrollTop = covList.scroll || 0;
      renderCovRows(true);
      el.dlChapters.hidden = false;
    } catch (e) { console.error(e); }
  }

  // ---------- каталог книг на сервере ----------
  let catItems = null, catError = "", catLoading = false;
  const catBusy = new Set();
  async function loadCatalog() {
    if (catLoading) return;
    catLoading = true; catError = "";
    if (!catItems) el.catList.innerHTML = '<div class="cat-msg">Загружаю список книг с сервера…</div>';
    try {
      if (offlineMode) {
        catItems = null; catLoading = false;
        el.catList.innerHTML = `<div class="cat-msg">Включён режим «Без сервера» — каталог недоступен.
          <button class="set-btn" data-act="online">Подключиться к серверу</button></div>`;
        el.catInfo.textContent = "";
        return;
      }
      const data = Native ? await Native.catalog() : await fetch("api/catalog").then(async (r) => {
        if (!r.ok) throw new Error(await httpError(r, "catalog"));
        return r.json();
      });
      catItems = (data && data.items) || [];
    } catch (e) {
      catError = netMessage(e);
    }
    catLoading = false;
    renderCatalog();
  }
  const catVL = VList(el.catList);
  const catKey = (it) => it._q || (it._q = (it.title + " " + (it.authors || []).join(" ") + " " + it.name + " " + it.folder).toLowerCase());
  function renderCatalog() {
    if (catError) {
      catVL.set([]);
      el.catList.innerHTML = `<div class="cat-msg">Не получилось загрузить каталог:<br>${esc(catError)}</div>`;
      el.catInfo.textContent = "";
      return;
    }
    if (!catItems) return;
    const q = el.catSearch.value.trim().toLowerCase();
    const list = catItems.filter((it) => !q || catKey(it).includes(q));
    const coll = new Intl.Collator("ru");
    list.sort((a, b) => coll.compare(a.folder, b.folder) || coll.compare(a.title, b.title));
    const have = new Set(libCache.map((m) => m.id));
    const anyFolder = list.some((x) => x.folder);
    const rows = [];
    let folder = null;
    for (const it of list) {
      if (it.folder !== folder) {
        folder = it.folder;
        if (anyFolder) rows.push({ key: "f:" + folder, est: 34, html: `<div class="cat-folder" data-vi="${rows.length}">${esc(folder || "Без папки")}</div>` });
      }
      const inLib = have.has(it.id), busy = catBusy.has(it.id);
      rows.push({ key: it.id + "|" + it.folder, est: 76, html: `<div class="cat-item" data-vi="${rows.length}" data-id="${it.id}">
        <div class="cat-info">
          <div class="cat-title">${esc(it.title)}</div>
          <div class="cat-author">${esc((it.authors || []).join(", ") || "Автор не указан")}</div>
          <div class="cat-meta">${it.kind === "audio" ? '<svg class="lib-ab" aria-label="Аудиокнига"><use href="#i-voice"/></svg>' : ""}<span class="badge">${esc(it.format)}</span>${fmtSize(it.size || 0)}</div>
        </div>
        <button class="cat-btn${inLib ? " have" : ""}" data-act="${inLib ? "open" : "get"}"${busy ? " disabled" : ""}>${busy ? "Загрузка…" : inLib ? "Открыть" : "Скачать"}</button>
      </div>` });
    }
    catVL.set(rows);
    if (!rows.length) el.catList.innerHTML = `<div class="cat-msg">${catItems.length ? "Ничего не найдено" :
      "Каталог пуст.<br>Положите книги в папку <b>catalog</b> рядом с сервером BookReader на ПК и обновите список."}</div>`;
    const inLibCount = catItems.filter((it) => have.has(it.id)).length;
    el.catInfo.textContent = catItems.length
      ? `Книг на сервере: ${catItems.length}` + (inLibCount ? ` · уже в библиотеке: ${inLibCount}` : "") + ". Скачанная книга хранится на этом устройстве."
      : "";
  }
  async function catalogGet(it) {
    catBusy.add(it.id); renderCatalog();
    try {
      if (Native) {
        const res = await Native.catalogFetch(it.id, it.name);
        if (it.kind === "audio") await Audiobook.importNative([res]);
        else await importNative([res]);
      } else {
        const r = await fetch("api/catalog/file/" + it.id);
        if (!r.ok) throw new Error(await httpError(r, "catalog-file"));
        const blob = await readWithProgress(r, it);
        if (it.kind === "audio") await Audiobook.addFromCatalog(blob, it);
        else await addFiles([new File([blob], it.name, { type: blob.type })], false);
      }
      await refreshLibrary();
      toast(`«${it.title}» — в библиотеке`);
    } catch (e) {
      toast(`«${it.title}»: ${netMessage(e)}`, 6000);
    }
    catBusy.delete(it.id);
    renderCatalog();
  }
  // скачивание из каталога в браузере: большие файлы (аудиокниги) — с процентами
  async function readWithProgress(r, it) {
    const total = Number(r.headers.get("Content-Length")) || it.size || 0;
    if (!r.body || !r.body.getReader || total < 8 * 1024 * 1024) return r.blob();
    const rd = r.body.getReader(), parts = [];
    let got = 0, shown = -1;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      const pct = Math.floor((got / total) * 100);
      if (pct !== shown && pct % 2 === 0) { shown = pct; toast(`«${it.title}»: скачано ${pct}%`, 8000); }
    }
    return new Blob(parts);
  }
  el.btnCatalog.onclick = () => showView("catalog");
  el.catRefresh.onclick = () => loadCatalog();
  el.catSearch.oninput = debounce(() => { renderCatalog(); el.catList.scrollTop = 0; }, 150);
  el.catList.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="online"]')) { setOfflineMode(false).then(loadCatalog); return; }
    const btn = e.target.closest(".cat-btn");
    if (!btn || btn.disabled) return;
    const it = (catItems || []).find((x) => x.id === btn.closest(".cat-item").dataset.id);
    if (!it) return;
    if (btn.dataset.act === "open") { showView("lib"); openFromLibrary(it.id); }
    else catalogGet(it);
  });

  // ---------- ошибки сети понятными словами ----------
  function netMessage(e) {
    if (!e) return "неизвестная ошибка";
    // fetch не смог соединиться: сервер выключен, ПК спит, нет сети
    if (e.name === "TypeError" && /fetch|network|load/i.test(e.message || "")) {
      return "нет связи с сервером озвучки — проверьте, что ПК включён и на нём запущен BookReader.bat";
    }
    if (e.name === "AbortError") return "сервер не ответил вовремя";
    return e.message || String(e);
  }
  async function httpError(r, what) {
    let detail = "";
    try { detail = (await r.clone().json()).error || ""; } catch (_) {}
    const d = detail ? ": " + detail : "";
    switch (r.status) {
      case 404:
        if (what === "catalog") return detail.includes("выключен") ? "каталог на сервере выключен (сервер запущен с --no-catalog)" : "на сервере нет каталога — обновите BookReader на ПК";
        if (what === "catalog-file") return "этой книги уже нет в каталоге — обновите список";
        return "сервер не знает этой команды — обновите BookReader на ПК";
      case 500: return (what === "tts" ? "сервер не смог озвучить фразу" : "внутренняя ошибка сервера") + d + ". Подробности — в окне сервера на ПК";
      case 429: return detail || "сервер занят озвучкой для других устройств — попробуйте чуть позже";
      case 502: case 503: case 504: return "сервер перегружен или перезапускается — попробуйте через минуту";
      default: return `сервер ответил ошибкой (код ${r.status})` + d;
    }
  }

  // ---------- плашка о сервере: можно скрыть ✕ ----------
  let warnState = null, warnDismissed = null;
  function setWarn(kind, detail) {
    if (kind && autonomous()) kind = null;            // автономный режим — сервера нет и не нужно
    if (kind !== warnState) warnDismissed = null;
    warnState = kind;
    if (!kind || warnDismissed === kind) { el.warn.hidden = true; return; }
    let text;
    if (kind === "unreachable") {
      text = "Сервер озвучки недоступен" + (detail ? `: ${esc(detail)}` : "") + ". Книги с загруженной озвучкой (метка «Загружено») читаются и так.";
    } else if (Native) {
      text = "Сервер озвучки не отвечает" + (detail ? `: ${esc(detail)}` : "") + ". Адрес — в настройках подключения.";
    } else {
      // подсказка про BookReader.bat — если её ещё нет в тексте ошибки (иначе фраза повторялась дважды)
      text = (detail ? esc(detail) : "Сервер озвучки не отвечает") +
        (detail && /BookReader\.bat/.test(detail) ? "." : ". Запустите <b>BookReader.bat</b> на ПК и обновите страницу.");
    }
    el.warnText.innerHTML = text;
    el.warnText.title = el.warnText.textContent;   // полный текст, если на маленьком экране он сокращён
    el.warn.hidden = false;
  }
  el.warnClose.onclick = () => { warnDismissed = warnState; el.warn.hidden = true; };

  // Высота плашки (с отступами) → --warn-h: в постраничном режиме страницы начинаются под ней.
  // Плашка появилась, скрылась, перенесла строки — пересчитываем страницы, оставаясь на том же месте.
  let warnH = 0, warnT = 0;
  function syncWarnHeight() {
    let h = 0;
    if (!el.warn.hidden) {
      const cs = getComputedStyle(el.warn);
      h = Math.ceil(el.warn.offsetHeight + parseFloat(cs.marginTop || 0) + parseFloat(cs.marginBottom || 0));
    }
    if (h === warnH) return;
    warnH = h;
    document.documentElement.style.setProperty("--warn-h", h + "px");
    if (!isPaged()) return;
    clearTimeout(warnT);
    const anchor = layoutAnchor();
    warnT = setTimeout(() => layoutPaged(anchor), 60);
  }
  if (window.ResizeObserver) new ResizeObserver(syncWarnHeight).observe(el.warn);
  new MutationObserver(syncWarnHeight).observe(el.warn, { attributes: true, attributeFilter: ["hidden"] });
  el.warnOffline.onclick = () => setOfflineMode(true);

  // ---------- режим «Без сервера» (приложение) ----------
  let offlineMode = false;
  // ---------- режим работы (приложение): с сервером / без сервера / автономный (шаг 7) ----------
  // Автономный режим — только чтение (и готовые аудиокниги — шаг 8): всё, что связано с нейроозвучкой и сервером,
  // скрыто (элементы с классом tts-only), в сеть не ходим (кроме ручной проверки обновлений). Скачанная озвучка
  // не удаляется — обратное переключение возвращает всё как было.
  let appMode = "online";
  const autonomous = () => appMode === "autonomous";
  // что доступно в текущем режиме; шаг 8 — добавить сюда «audiobooks» (в автономном режиме тоже true)
  function modeAllows(feature) {
    if (feature === "tts" || feature === "server") return !autonomous();
    if (feature === "audiobooks") return true;   // шаг 8: плеер готовых аудиокниг работает в любом режиме
    return true;
  }
  function applyMode() {
    document.documentElement.classList.toggle("autonomous", autonomous());
    if (autonomous()) {
      if (playing) pause();
      setPick(-1);
      setWarn(null);
      if (!el.catPanel.hidden) showView("lib");
      closeDl();
    }
    syncPlayerHeight();             // плеер скрыт — отступ снизу под него не нужен
    if (isPaged() && segs.length) layoutPaged(layoutAnchor());   // страницы — заново под новую высоту (иначе пустое место внизу)
    renderLibrary();                // значки озвучки у книг
  }
  async function setMode(mode, quiet) {
    if (!Native) return;
    try { await Native.call("SetMode", mode); }
    catch (_) { try { await Native.call("SetOffline", mode === "online" ? "false" : "true"); } catch (_) {} }   // старое приложение
    appMode = mode;
    offlineMode = mode !== "online";
    el.setServer.value = mode;
    applyMode();
    if (!quiet) toast(mode === "autonomous" ? "Автономный режим: только чтение, без сервера и нейроозвучки"
      : mode === "offline" ? "Режим «Без сервера»: читаются только книги с загруженной озвучкой" : "Подключаюсь к серверу…", 3500);
    await loadServerInfo();
    if (mode === "online" && !warnState && !quiet) toast("Сервер на связи");
    refreshAudio();
    if (!el.catPanel.hidden) loadCatalog();
  }
  const setOfflineMode = (on) => setMode(on ? "offline" : "online");
  el.setServer.onchange = () => setMode(el.setServer.value);

  // ---------- окно-вопрос (соглашение, первый запуск, выбор голоса) ----------
  const askEl = { box: $("ask"), head: $("askHead"), body: $("askBody"), actions: $("askActions"), close: $("askClose") };
  let askDone = null, askGuard = null;
  // buttons: [{ label, primary, value }] → промис со значением нажатой кнопки (null — закрыли).
  // beforeClose — для окон с несохранёнными изменениями: вызывается при закрытии (✕, «Отмена», фон, «Назад»),
  // промис false — окно остаётся открытым.
  // top — окно с полями ввода: прижато к верху (клавиатура телефона его не закрывает)
  function ask(title, html, buttons, { closable = true, beforeClose = null, top = false } = {}) {
    if (askDone) askDone(null);
    askEl.box.classList.toggle("pr-open", top);
    askGuard = beforeClose;
    askEl.head.textContent = title;
    askEl.body.innerHTML = html;
    askEl.body.scrollTop = 0;
    askEl.close.hidden = !closable;
    askEl.actions.innerHTML = buttons.map((b, i) =>
      `<button class="set-btn${b.primary ? " primary" : ""}${b.danger ? " danger" : ""}" data-i="${i}">${esc(b.label)}</button>`).join("");
    askEl.actions.classList.toggle("col", buttons.length > 2); // много вариантов — каждый во всю ширину
    askEl.box.hidden = false;
    askEl.box.dataset.closable = closable ? "1" : "";
    return new Promise((res) => {
      askDone = (v) => { askDone = null; askGuard = null; askEl.box.hidden = true; res(v); };
      askEl.actions.querySelectorAll("button").forEach((btn) => (btn.onclick = () => {
        const v = buttons[Number(btn.dataset.i)].value;
        if (v === null) askCancel(); else askDone(v);
      }));
    });
  }
  // закрыть окно вопроса по желанию пользователя (✕, «Отмена», фон, Esc, «Назад») — с проверкой несохранённого
  async function askCancel() {
    if (!askDone) return;
    const done = askDone;
    if (askGuard) {
      let ok = true;
      try { ok = await askGuard(); } catch (_) {}
      if (!ok || askDone !== done) return;
    }
    done(null);
  }
  askEl.close.onclick = () => askCancel();
  askEl.box.addEventListener("click", (e) => { if (e.target === askEl.box && askEl.box.dataset.closable) askCancel(); });

  function licenseHtml(intro) {
    const L = window.LEGAL;
    if (!L) return "<p>Текст лицензии не найден.</p>";
    return (intro ? `<p>${intro}</p>` : "") +
      `<ul>${L.summary.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      <details><summary>Полный текст лицензии (MIT-0, перевод)</summary><pre>${esc(L.licenseRu)}</pre></details>
      <details><summary>Оригинал (English)</summary><pre>${esc(L.licenseEn)}</pre></details>
      <details><summary>Сторонние компоненты</summary><table>${L.thirdParty.map(([n, l]) => `<tr><td>${esc(n)}</td><td>${esc(l)}</td></tr>`).join("")}</table></details>`;
  }
  // ---------- личные правила произношения (pron.js) ----------
  $("btnPron").onclick = () => Pron.dialog({
    ask, askEl, esc, toast, askCancel,
    askFinish: (v) => { if (askDone) askDone(v); },   // закрыть окно без проверки «не сохранено» (уже сохранили)
    library: async () => (await Library.list()).map((b) => ({ id: b.id, title: b.title || b.name || b.id })),
    catalog: () => (catItems || []).map((c) => ({ id: c.id, title: c.title || c.name || c.id })),
    speak: async (text, extra) => {
      if (Native) {   // в приложении — через нативную часть (у неё адрес сервера)
        if (!Native.pronPreview) throw new Error("обновите приложение");
        return Native.pronPreview(text, el.voice.value, JSON.stringify({ ...Pron.payload(bookId), ...extra }));
      }
      const r = await fetch("api/tts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, speaker: el.voice.value, pause: 0.1, ...Pron.payload(bookId), ...extra }),
      });
      if (!r.ok) throw new Error(await httpError(r, "tts"));
      return r.blob();
    },
  }).then((changed) => { if (changed) pronApplied("Произношение обновлено"); });

  // правила или порядок дат изменились — уже полученная озвучка устарела, получаем заново
  function pronApplied(msg) {
    act("произношение изменено");
    if (!Native) {
      const wasPlaying = playing;
      clearAudioCache();
      if (wasPlaying && cur >= 0) readFrom(cur);
    } else Native.pronChanged();
    if (msg) toast(msg, 2500);
  }
  // порядок дня и месяца (01.02.2001) — общая настройка; хранится вместе с правилами (pron.js)
  const dateSel = $("setDateOrder");
  dateSel.value = (Pron.get().opts || {}).date_order || "dmy";
  dateSel.onchange = async () => {
    const d = Pron.get();
    await Pron.save({ rules: d.rules, opts: { ...(d.opts || {}), date_order: dateSel.value } });
    pronApplied();
  };

  // «Освободить место» (настройки): ненужная скачанная озвучка (приложение) и — отдельным подпунктом — вся библиотека.
  // Всё необратимое — только после второго окна со списком того, что удалится.
  $("btnSpace").onclick = () => spaceDialog();
  // preset — отметки, с которыми окно открыть снова («Отмена» в подтверждении возвращает сюда же)
  async function spaceDialog(preset) {
    const audio = !!(Native && Native.Audio.cleanInfo);
    if (Native && !audio) return toast("Обновите приложение");
    let info = {};
    if (audio) {
      try { info = await Native.Audio.cleanInfo(); } catch (e) { return toast("Не получилось посчитать: " + e.message, 4000); }
    }
    const books = libCache.length;
    const n = (k, a, b, c) => `${k.toLocaleString("ru")} ${plural(k, a, b, c)}`;
    const opt = (id, on, title, size, hint, disabled, cls = "") => `<label class="sp-opt${cls}${disabled ? " off" : ""}"><input type="checkbox" id="${id}"${on && !disabled ? " checked" : ""}${disabled ? " disabled" : ""}>
      <span><b>${title}</b> — ${size}${hint ? `<small>${hint}</small>` : ""}</span></label>`;
    const html = `<div class="sp">
      ${audio ? `<p class="pr-hint">Всего скачанной озвучки: <b>${fmtSize(info.totalBytes || 0)}</b>.</p>
      ${opt("spOrphans", true, "Озвучка книг, которых нет в библиотеке", info.orphanBooks ? `${n(info.orphanBooks, "книга", "книги", "книг")}, ${fmtSize(info.orphanBytes)}` : "нет", "", !info.orphanBooks)}
      ${opt("spTemp", true, "Недописанные и временные файлы", info.tempBytes ? fmtSize(info.tempBytes) : "нет", "остались после обрывов связи", !info.tempBytes)}
      ${opt("spOutdated", false, "Старый вариант фраз, ожидающих обновления", info.outdatedPhrases ? `${n(info.outdatedPhrases, "фраза", "фразы", "фраз")}, ${fmtSize(info.outdatedBytes)}` : "нет",
        "в том числе скачанных до 1.2.0. Эти фразы будут звучать с сервера — уже с текущими правилами; без сервера их не будет", !info.outdatedPhrases)}
      ${opt("spAll", false, "Вся скачанная озвучка", fmtSize(info.totalBytes || 0), "книги останутся, озвучку можно скачать заново" + (info.busy ? "; идущие загрузки будут остановлены" : ""), !info.totalBytes)}` : ""}
      ${opt("spLib", false, "Вся библиотека", books ? n(books, "книга", "книги", "книг") : "пусто",
        "книги, прогресс чтения" + (audio ? " и вся их озвучка" : "") + ". Удаляются с этого устройства безвозвратно", !books, audio ? " sub danger" : " danger")}
      ${audio && info.busy ? '<p class="pr-hint">Озвучка, которая сейчас загружается, не удаляется (кроме «Вся скачанная озвучка» и «Вся библиотека»).</p>' : ""}
    </div>`;
    const go = ask("Освободить место", html, [{ label: "Отмена", value: null }, { label: "Удалить", primary: true, danger: true, value: 1 }]);
    const body = askEl.body;
    const box = (id) => body.querySelector("#" + id);
    const lib = box("spLib"), all = box("spAll");
    const minor = ["spOrphans", "spTemp", "spOutdated"].map(box).filter(Boolean);
    minor.forEach((x) => { if (x.disabled) x.dataset.none = "1"; });
    const sync = () => {
      // вся библиотека включает всю озвучку; вся озвучка включает остальные пункты
      if (all && lib.checked) all.checked = true;
      if (all) { all.disabled = lib.checked || !info.totalBytes; all.closest(".sp-opt").classList.toggle("off", all.disabled); }
      minor.forEach((x) => x.closest(".sp-opt").classList.toggle("off", (all && all.checked) || x.dataset.none === "1"));
    };
    lib.onchange = sync;
    if (all) all.onchange = sync;
    if (preset) {
      const ids = { library: "spLib", all: "spAll", orphans: "spOrphans", temp: "spTemp", outdated: "spOutdated" };
      for (const [k, id] of Object.entries(ids)) { const x = box(id); if (x && !x.disabled) x.checked = !!preset[k]; }
      if (all && preset.all) all.checked = true;
      sync();
    }
    if (!(await go)) return;
    const val = (x) => !!(x && x.checked && (!x.disabled || x === all));
    const opts = { library: val(lib), all: val(all), orphans: val(box("spOrphans")), temp: val(box("spTemp")), outdated: val(box("spOutdated")) };
    if (!Object.values(opts).some(Boolean)) return toast("Ничего не отмечено");

    // подтверждение: явно — что отмечено и что удалится безвозвратно
    const items = [];
    if (opts.library) items.push(`<li><b>Вся библиотека</b> — ${n(books, "книга", "книги", "книг")} вместе с прогрессом чтения${audio ? " и всей озвучкой" : ""}</li>`);
    if (opts.all && !opts.library) items.push(`<li><b>Вся скачанная озвучка</b> — ${fmtSize(info.totalBytes || 0)}</li>`);
    if (!opts.all) {
      if (opts.orphans) items.push(`<li>Озвучка книг, которых нет в библиотеке — ${fmtSize(info.orphanBytes || 0)}</li>`);
      if (opts.temp) items.push(`<li>Недописанные и временные файлы — ${fmtSize(info.tempBytes || 0)}</li>`);
      if (opts.outdated) items.push(`<li>Старый вариант фраз, ожидающих обновления — ${n(info.outdatedPhrases || 0, "фраза", "фразы", "фраз")}</li>`);
    }
    const sure = await ask(opts.library || opts.all ? "Удалить безвозвратно?" : "Удалить?",
      `<p>Отмечено к удалению:</p><ul class="sp-list">${items.join("")}</ul>
       <p><b>Это удалится с устройства безвозвратно</b> — отменить нельзя.${opts.library ? " Книги можно будет добавить заново только из файлов или каталога." : ""}</p>`,
      [{ label: "Отмена", value: null }, { label: "Удалить безвозвратно", primary: true, danger: true, value: 1 }]);
    if (!sure) return spaceDialog(opts);   // передумали — обратно в окно очистки, отметки те же
    try {
      if (opts.library) {
        await Library.clear();          // в приложении вместе с книгами удаляется и вся озвучка
        closeBook();
        await refreshLibrary();
        toast("Библиотека очищена");
      } else {
        const r = await Native.Audio.clean(opts);
        toast(`Освобождено: ${fmtSize((r && r.freed) || 0)}`, 3500);
      }
    } catch (e) { toast("Не получилось: " + e.message, 4000); }
    if (Native) await refreshAudio();
    renderUsage();
  }

  $("btnLicense").onclick = () => ask("Лицензия BookReader", licenseHtml(), [{ label: "Закрыть", primary: true, value: 1 }]);

  // первый запуск приложения: соглашение → подключить сервер? → если нет, где это сделать
  async function firstRun() {
    if (!Native || !window.LEGAL) return;
    let accepted = null;
    try { accepted = await Native.getPref("license"); } catch (_) {}
    if (accepted !== window.LEGAL.version) {
      const ok = await ask("Пользовательское соглашение", licenseHtml("Перед началом работы прочитайте условия использования."),
        [{ label: "Не принимаю", value: "no" }, { label: "Принимаю", primary: true, value: "yes" }], { closable: false });
      if (ok !== "yes") {
        await ask("Соглашение не принято", "<p>Без принятия соглашения пользоваться приложением нельзя. Его можно принять при следующем запуске.</p>",
          [{ label: "Закрыть приложение", primary: true, value: 1 }], { closable: false });
        Native.exit();
        return false;
      }
      await Native.setPref("license", window.LEGAL.version);
    }
    let asked = null;
    try { asked = await Native.getPref("serverAsked"); } catch (_) {}
    if (!asked && !(await Native.hasServer())) {
      await Native.setPref("serverAsked", "1");
      const yes = await ask("Подключить сервер озвучки?",
        `<p>Чтобы <b>слушать</b> книги, нужен сервер BookReader на компьютере — он озвучивает текст голосами Silero.
         Если сервер уже запущен на ПК в той же сети (Wi-Fi или точка доступа телефона), приложение найдёт его само.</p>
         <p>Без сервера приложение работает как обычная читалка — <b>автономный режим</b>: только чтение, без озвучки
         и без подключения к сети. Переключить можно в любой момент: Настройки → «Режим».</p>`,
        [{ label: "Читать без сервера", value: "no" }, { label: "Подключить сервер", primary: true, value: "yes" }], { closable: false });
      if (yes === "yes") { Native.openSettings(true); return true; }
      await setMode("autonomous", true);
      return true;
    }
    return true;
  }

  // фрагмент не озвучен (нет сервера / не скачан) — предложить скачанный голос или загрузку текущим
  let voiceOfferShown = 0;
  async function offerDownloadedVoice() {
    if (!Native || !bookId || Date.now() - voiceOfferShown < 15000) return false;
    const curVoice = el.voice.value;
    const others = rowsOf(bookId).filter((r) => r.voice !== curVoice && r.done > 0)
      .sort((a, b) => b.done / (b.total || 1) - a.done / (a.total || 1));
    const mine = rowsOf(bookId).find((r) => r.voice === curVoice);
    if (!others.length && offlineMode && !(mine && mine.done)) return false;
    voiceOfferShown = Date.now();
    const pct = (r) => (r.total ? Math.floor((r.done / r.total) * 100) : 0);
    const buttons = [];
    let html = `<p>Это место книги не озвучено голосом «${esc(voiceName(curVoice))}»` +
      (offlineMode ? ", а включён режим «Без сервера»." : " и сервер сейчас недоступен.") + "</p>";
    if (others.length) {
      const o = others[0];
      html += `<p>Есть загруженная озвучка: <b>Озвучка — ${esc(voiceName(o.voice))}</b> (загружено ${pct(o)}%) — её можно слушать без сервера.</p>`;
      buttons.push({ label: `Слушать: Озвучка — ${voiceName(o.voice)}`, primary: true, value: "switch:" + o.voice });
    }
    if (!offlineMode) buttons.push({ label: `Скачать голосом «${voiceName(curVoice)}»`, value: "download" });
    else buttons.push({ label: "Подключиться к серверу", value: "online" });
    buttons.push({ label: "Отмена", value: null });
    const v = await ask("Озвучка недоступна", html, buttons);
    if (!v) return true;
    if (v.startsWith("switch:")) {
      pickVoice(v.slice(7));
      el.voice.onchange();
      setTimeout(() => playFrom(cur), 100);
    } else if (v === "download") {
      openDl();
      el.dlVoice.value = curVoice;
      updateDl();
    } else if (v === "online") {
      await setOfflineMode(false);
    }
    return true;
  }


  // ---------- «Назад» (кнопка Android) и клавиатура ----------
  const isField = (n) => n && n.matches && n.matches("input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select, [contenteditable]");
  function hideKeyboard() {
    const a = document.activeElement;
    if (isField(a)) { a.blur(); return true; }
    return false;
  }
  // Открыта экранная клавиатура (фокус в поле ввода) — касание пальцем в любом месте только прячет её,
  // интерфейс это касание не получает. Касание другого поля ввода — просто переводит в него курсор.
  // Один обработчик на весь интерфейс; мышь (ПК) работает как обычно.
  const typing = (n) => n && n.matches && n.matches("textarea, [contenteditable], input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=button]):not([type=submit]):not([type=reset]):not([type=color])");
  let swallow = null;           // поле, клавиатуру которого прячет текущее касание
  const dropKeyboard = (e) => {
    if (!swallow) return;
    e.preventDefault();         // не будет ни click, ни переноса фокуса
    e.stopPropagation();        // и обработчики интерфейса касания не увидят
    const a = swallow;
    swallow = null;
    a.blur();
  };
  window.addEventListener("pointerdown", (e) => {
    swallow = null;
    if (e.pointerType === "mouse" || !typing(document.activeElement) || (e.target.closest && typing(e.target.closest("input, textarea, [contenteditable]")))) return;
    swallow = document.activeElement;
    e.preventDefault();         // фокус остаётся до конца касания — ничего не сдвигается под пальцем
    e.stopPropagation();
  }, true);
  window.addEventListener("touchstart", (e) => { if (swallow) e.stopPropagation(); }, true);
  window.addEventListener("touchend", dropKeyboard, true);
  window.addEventListener("pointerup", (e) => { if (swallow && e.pointerType !== "touch") dropKeyboard(e); }, true);   // перо
  window.addEventListener("click", (e) => { if (swallow) dropKeyboard(e); }, true);
  // «Готово»/Enter на клавиатуре в полях поиска — убрать клавиатуру
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches && e.target.matches("input[type=search]")) e.target.blur();
  }, true);

  // закрыть самое верхнее: клавиатура → вопрос → окно загрузки → меню книги → подраздел панели → панель
  function goBack() {
    if (window.Picker && Picker.close()) return true;   // открыт выбор из списка
    if (hideKeyboard()) return true;
    if (!askEl.box.hidden) {
      if (askEl.box.dataset.closable) askCancel();
      return true; // соглашение при первом запуске «Назад» не закрывает
    }
    if (Pron.isOpen()) { Pron.back(); return true; }   // страница «Произношение»: на уровень выше / закрыть
    if (!el.dl.hidden) { closeDl(); return true; }
    if (el.lib.classList.contains("open")) {
      if (!el.setPanel.hidden || !el.catPanel.hidden) { showView("lib"); return true; }
      if (selecting) { setSelecting(false); return true; }
      closePanels(); return true;
    }
    if (el.toc.classList.contains("open")) { closePanels(); return true; }
    if (book || Audiobook.active) { goHome(); return true; }   // книга → стартовый экран (место сохранено)
    return false;
  }


  // ---------- есть загруженные озвучки — какой слушать? ----------
  // Спрашиваем при ▶, если для книги загружена озвучка, отличная от выбранного голоса. Выбор запоминается для книги
  // (пока набор загруженных озвучек не изменится). ✕ — ничего не включать: при следующем ▶ спросим снова.
  // Результат: "cancel" — не играть, "switched" — голос сменили, "keep" — играть как есть.
  const prepSig = (rows) => rows.map((r) => r.voice).sort().join(",");
  function rememberVoice(v) {
    if (!bookId) return;
    const rows = rowsOf(bookId).filter((r) => r.done > 0 || r.running);
    store.set("voiceChoice:" + bookId, { voice: v, sig: prepSig(rows) });
  }
  async function preferPrepared() {
    if (!Native || !bookId) return "keep";
    const curVoice = el.voice.value;
    const rows = rowsOf(bookId).filter((r) => r.done > 0 || r.running)
      .sort((a, b) => b.done - a.done);
    if (!rows.length) return "keep";
    const mine = rows.find((r) => r.voice === curVoice);
    if (mine && rows.every((r) => r.done <= mine.done)) return "keep"; // выбранный голос и так лучший
    const saved = store.get("voiceChoice:" + bookId, null);
    if (saved && saved.sig === prepSig(rows)) {
      if (saved.voice === curVoice || saved.voice === "server") return "keep";
      pickVoice(saved.voice); el.voice.onchange();
      return "switched";
    }
    const pct = (r) => (r.total ? Math.floor((r.done / r.total) * 100) : 0);
    const buttons = rows.map((r, k) => ({
      label: `Озвучка — ${voiceName(r.voice)} · ${r.running ? "загружается " : "загружено "}${pct(r)}%`,
      primary: k === 0, value: "v:" + r.voice,
    }));
    if (!offlineMode && !mine) buttons.push({ label: `Генерировать на сервере — ${voiceName(curVoice)}`, value: "server" });
    const v = await ask("Какую озвучку слушать?",
      `<p>Для этой книги есть загруженная озвучка. Она читается с телефона — сразу, без ожидания и без повторной генерации на сервере.</p>` +
      "", buttons);
    if (!v) return "cancel";
    if (v === "server") { store.set("voiceChoice:" + bookId, { voice: "server", sig: prepSig(rows) }); return "keep"; }
    const voice = v.slice(2);
    store.set("voiceChoice:" + bookId, { voice, sig: prepSig(rows) });
    if (voice === curVoice) return "keep";
    pickVoice(voice);
    el.voice.onchange();
    return "switched";
  }

  // ---------- фразы книги без открытия (групповая загрузка) ----------
  // Должно совпадать с render(): тот же текст и те же паузы → те же ключи файлов, плеер найдёт загруженное.
  const PAUSE = { title: 0.9, subtitle: 0.6, verse: 0.25, author: 0.6, pre: 0.35 };
  function bookSegments(b) {
    const out = [];
    const add = (parts, last) => parts.forEach((t, k) => out.push([t.trim(), k === parts.length - 1 ? last : 0.12]));
    add([b.title], 0.8);
    out[0][0] = (b.authors.length ? b.authors.join(", ") + ". " : "") + b.title;
    for (const it of b.items) {
      if (it.kind === "empty" || it.kind === "image") continue;
      add(splitSentences(it.text), PAUSE[it.kind] ?? 0.35);
    }
    return out;
  }

  // для автотестов: сверка разбивки, открытие книги и замеры скорости
  window.BookReaderDebug = { bookSegments, openFromLibrary, closeBook: () => closeBook(), clearCache: () => [...bookCache.keys()].forEach(forgetBook), setViewMode: (v) => setViewMode(v), stats: () => ({ playing, cur, pick, sleep, view: settings.view, segs: segs.length, sections: sections.length, attached: el.reader.childElementCount }) };

  // ---------- групповая озвучка (выбор нескольких книг → «Озвучка») ----------
  async function groupAudio() {
    const picked = selBooks();
    const list = picked.filter((m) => m.format !== "audio");   // у аудиокниг свой звук — их не озвучиваем
    const nAudio = picked.length - list.length;
    if (!list.length) return toast("Выбраны только аудиокниги — озвучивать нечего");
    const withAudio = list.filter((m) => rowsOf(m.id).some((r) => r.done > 0 || r.running || r.queued));
    const nb = (n) => `${n} ${plural(n, "книга", "книги", "книг")}`, na = (n) => `${n} ${plural(n, "аудиокнига", "аудиокниги", "аудиокниг")}`;
    const p = ask(`Озвучка: ${nb(list.length)}`,
      (nAudio ? `<p class="grp-note">Выбрано: ${nb(list.length)} и ${na(nAudio)}. ${list.length % 10 === 1 && list.length % 100 !== 11 ? "Будет озвучена" : "Будут озвучены"} ${nb(list.length)}.</p>` : "") +
      `<label class="set-field"><span>Голос</span><select id="grpVoice">${el.voice.innerHTML}</select></label>
       <p>Книги озвучиваются по очереди: одна загружается, остальные — в ожидании загрузки. Уже загруженные фразы повторно не качаются.</p>`,
      [{ label: "Загрузить озвучку", primary: true, value: "load" }]
        .concat(withAudio.length ? [{ label: `Удалить всю озвучку (${withAudio.length})`, danger: true, value: "del" }] : []));
    const sel = document.getElementById("grpVoice");
    if (sel) sel.value = el.voice.value;
    const act = await p;
    const voice = sel ? sel.value : el.voice.value;
    if (act === "del") return deleteGroupAudio(withAudio);
    if (act !== "load") return;
    if (offlineMode) return toast("Включён режим «Без сервера» — загружать не с чего");
    let added = 0, skipped = 0, failed = 0;
    for (const [k, m] of list.entries()) {
      const row = rowsOf(m.id).find((r) => r.voice === voice);
      if (row && row.total && row.done >= row.total) { skipped++; continue; } // уже загружена целиком
      toast(`Готовлю книги к загрузке: ${k + 1} из ${list.length}…`, 8000);
      try {
        const rec = await Library.getFile(m.id);
        if (!rec) throw new Error("файл не найден");
        const b = await Books.parseBuffer(rec.data, rec.name);
        if (m.customMeta) { b.title = m.title; b.authors = m.authors || []; }
        if (m.chapters) Books.applyChapters(b, m.chapters);
        const segsOfBook = bookSegments(b);
        releaseUrls(b);
        await Native.Audio.enqueue(m.id, m.title, voice, segsOfBook);
        added++;
      } catch (e) {
        failed++;
        console.error(e);
      }
    }
    setSelecting(false);
    await refreshAudio();
    toast(`В очередь загрузки: ${added}` + (skipped ? ` · уже загружены: ${skipped}` : "") + (failed ? ` · не удалось прочитать: ${failed}` : ""), 5000);
  }
  async function deleteGroupAudio(list) {
    const bytes = list.reduce((sum, m) => sum + rowsOf(m.id).reduce((a, r) => a + (r.bytes || 0), 0), 0);
    const ok = await ask("Удалить озвучку?",
      `<p>Удалить всю загруженную озвучку (все голоса) у ${list.length} ${plural(list.length, "книги", "книг", "книг")} — около ${fmtSize(bytes)}?</p>
       <p>Сами книги останутся, читать вслух их можно будет через сервер.</p>`,
      [{ label: "Отмена", value: null }, { label: "Удалить озвучку", primary: true, danger: true, value: "yes" }]);
    if (ok !== "yes") return;
    for (const m of list) await Native.Audio.remove(m.id, null);
    await refreshAudio();
    renderUsage();
    scheduleCoverage();
    toast(`Озвучка удалена у ${list.length} ${plural(list.length, "книги", "книг", "книг")}`);
  }

  // ---------- очередь загрузки и обрыв связи ----------
  let queueState = { state: "idle", waiting: [], current: null, resumeAt: 0 };
  let reconnectShown = false, countdownTimer = 0;
  const qTitle = (x) => (x ? `«${x.title}» · Озвучка — ${voiceName(x.voice)}` : "");
  function renderQueueBar() {
    const q = queueState, bar = el.dlQueueBar;
    if (!Native || q.state === "idle") { bar.hidden = true; return; }
    const c = q.current, wait = q.waiting.length;
    const pct = c && c.total ? Math.floor((c.done / c.total) * 100) : 0;
    let text, cls = "";
    if (q.state === "nonet") { text = "⏸ Нет связи с сервером — загрузка на паузе и продолжится, когда связь восстановится"; cls = "warn"; }
    else if (q.state === "reconnected" || q.state === "held") { text = "✓ Связь восстановлена — ждёт вашего решения"; cls = "ok"; }
    else text = `⬇ Озвучивается ${qTitle(c)} — ${pct}%`;
    if (wait) text += ` · в очереди: ${wait}`;
    bar.className = "dl-queue " + cls;
    bar.innerHTML = `<span>${esc(text)}</span><button class="dl-queue-btn" id="dlQueueOpen">Очередь</button>`;
    bar.hidden = false;
    document.getElementById("dlQueueOpen").onclick = showQueue;
  }
  async function showQueue() {
    const q = queueState;
    const c = q.current;
    const pct = c && c.total ? Math.floor((c.done / c.total) * 100) : 0;
    const state = q.state === "nonet" ? "на паузе — нет связи" : q.state === "running" ? `озвучивается, ${pct}%` : "ждёт продолжения";
    const items = (c ? `<li><b>${esc(qTitle(c))}</b> — ${state}</li>` : "") +
      q.waiting.slice(0, 50).map((w) => `<li>${esc(qTitle(w))} — ожидает</li>`).join("") +
      (q.waiting.length > 50 ? `<li>…и ещё ${q.waiting.length - 50}</li>` : "");
    const v = await ask("Очередь загрузки озвучки", `<p>Книги озвучиваются по одной, остальные — в ожидании загрузки.</p><ul>${items || "<li>пусто</li>"}</ul>`,
      [{ label: "Закрыть", value: null }, { label: "Остановить и очистить очередь", value: "stop" }]);
    if (v === "stop") confirmCancelQueue(false);
  }
  async function confirmCancelQueue(fromReconnect) {
    const n = (queueState.current ? 1 : 0) + queueState.waiting.length;
    const v = await ask("Отменить загрузку?",
      `<p>Очередь загрузки будет очищена (${n} ${plural(n, "книга", "книги", "книг")}). Уже загруженная озвучка сохранится.</p>
       <p>Чтобы продолжить потом, книги нужно будет выбрать заново.</p>`,
      [{ label: "Вернуться", value: "back" }, { label: "Очистить очередь", primary: true, danger: true, value: "clear" }], { closable: false });
    if (v === "clear") {
      await Native.Audio.cancelAll();
      reconnectShown = false;
      toast("Очередь загрузки очищена");
    } else if (fromReconnect) showReconnect(false); // назад к выбору, но уже без счётчика
  }
  function showReconnect(withCounter) {
    reconnectShown = true;
    clearInterval(countdownTimer);
    const c = queueState.current, wait = queueState.waiting.length;
    const label = () => {
      if (!withCounter) return "Продолжить";
      const s = Math.max(0, Math.ceil((queueState.resumeAt - Date.now()) / 1000));
      return `(${s}) Продолжить`;
    };
    const p = ask("Связь с сервером восстановлена",
      `<p>Загрузка озвучки была приостановлена${c ? ": " + esc(qTitle(c)) : ""}${wait ? `, в очереди ещё ${wait}` : ""}.</p>` +
      (withCounter ? "<p>Если ничего не выбрать, загрузка продолжится сама.</p>" : ""),
      [{ label: label(), primary: true, value: "go" }, { label: "Отменить загрузку", value: "cancel" }], { closable: false });
    if (withCounter) countdownTimer = setInterval(() => {
      const b = askEl.actions.querySelector('[data-i="0"]');
      if (b) b.textContent = label();
    }, 250);
    p.then(async (v) => {
      clearInterval(countdownTimer);
      if (v === "go") { reconnectShown = false; await Native.Audio.resume(); }
      else if (v === "cancel") { await Native.Audio.hold(); confirmCancelQueue(true); }
    });
  }
  function onQueue(q) {
    if (!q) return;
    const prev = queueState.state;
    queueState = q;
    renderQueueBar();
    if (q.state === "nonet" && prev !== "nonet") toast("Связь с сервером потеряна — загрузка озвучки на паузе", 4000);
    if (q.state === "reconnected" && !reconnectShown) showReconnect(true);
    // продолжилось само (по таймеру) или связь снова пропала — окно выбора больше не нужно
    if ((q.state === "running" || q.state === "nonet" || q.state === "idle") && reconnectShown) {
      reconnectShown = false;
      clearInterval(countdownTimer);
      if (!askEl.box.hidden && askDone) askDone(null);
    }
  }

  // ---------- обновления (шаг 6): последний стабильный выпуск на GitHub ----------
  // Проверка — при первом запуске за день и кнопкой в настройках. Запрос к GitHub делает этот браузер/приложение
  // (GitHub видит только адрес); ничего, кроме номера версии, не отправляется. Сервер ставится только из браузера
  // на ПК с сервером (update.ps1), приложение — скачиванием APK во внешнем браузере.
  let serverMeta = null;          // { version, repo, here } — из /api/info
  let appVer = null;
  const verNum = (v) => (String(v || "").match(/\d+/g) || []).slice(0, 3).map(Number).concat([0, 0, 0]).slice(0, 3);
  const isNewer = (a, b) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
  const today = () => new Date().toISOString().slice(0, 10);
  // «Что нового» в окне обновления — только блок для читалки из описания выпуска (см. RELEASE.md, раздел 6):
  //   <!-- bookreader:whatsnew -->
  //   - коротко и только важное для пользователя
  //   <!-- /bookreader:whatsnew -->
  // На странице GitHub эти пометки не видны. Нет блока — «Что нового» не показываем (только ссылка на выпуск):
  // так в окно не попадёт инструкция по установке или полный список доработок.
  function whatsNew(body) {
    const m = /<!--\s*bookreader:whatsnew\s*-->([\s\S]*?)<!--\s*\/bookreader:whatsnew\s*-->/i.exec(String(body || ""));
    if (!m) return "";
    const lines = m[1].split(/\r?\n/)
      .map((x) => x.replace(/^\s*#+\s*/, "").replace(/\*\*|__|`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trimEnd())
      .filter((x, i, a) => x.trim() || (i > 0 && a[i - 1].trim()));
    return lines.slice(0, 15).join("\n").trim().slice(0, 1200);
  }
  async function fetchLatest(repo) {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
    if (r.status === 404) return { version: "", none: true };
    if (!r.ok) throw new Error(r.status === 403 ? "GitHub временно ограничил запросы — попробуйте позже" : "GitHub ответил " + r.status);
    const j = await r.json();
    const assets = j.assets || [];
    const apk = assets.find((a) => /^BookReader-[\d.]+\.apk$/i.test(a.name));
    return {
      version: String(j.tag_name || "").replace(/^v/i, ""), notes: whatsNew(j.body), url: j.html_url,
      apk: apk ? apk.browser_download_url : null, apkSize: apk ? apk.size : 0,
      server: assets.some((a) => /^BookReader_Server_v[\d.]+_update\.zip$/.test(a.name)),
    };
  }
  async function checkUpdates(manual) {
    if (Native && !appVer) appVer = await Native.appVersion();
    const repo = (serverMeta && serverMeta.repo) || "farrgos0/BookReader";
    if (!manual && store.get("updDay", "") === today()) return renderUpdates();
    const btn = $("btnUpdCheck");
    btn.disabled = true;
    if (manual) btn.querySelector("span").textContent = "Проверяю…";
    try {
      const latest = await fetchLatest(repo);
      store.set("updLatest", latest);
      store.set("updDay", today());
      store.set("updError", "");
    } catch (e) {
      store.set("updError", netMessage(e));
      if (manual) toast("Не получилось проверить: " + netMessage(e), 4500);
    } finally { btn.disabled = false; }
    renderUpdates();
    const l = store.get("updLatest", null);
    if (l && l.version && (srvBehind(l) || appBehind(l))) {
      if (manual) updatesDialog();
      else if (store.get("updToldFor", "") !== l.version) toast(`Доступна новая версия BookReader ${l.version} — Настройки`, 5000);
      store.set("updToldFor", l.version);
    } else if (manual && l) toast("Установлены последние версии", 2500);
  }
  const srvBehind = (l) => !!(serverMeta && l.version && l.server && isNewer(l.version, serverMeta.version));
  const appBehind = (l) => !!(Native && appVer && l.version && l.apk && isNewer(l.version, appVer));
  // настройки: одна кнопка внизу и строка под ней; подробности и «Скачать»/«Установить» — в окне
  function renderUpdates() {
    const l = store.get("updLatest", null), err = store.get("updError", "");
    const btn = $("btnUpdCheck"), line = $("updLine");
    const avail = l && (srvBehind(l) || appBehind(l));
    btn.classList.toggle("primary", !!avail);
    btn.querySelector("span").textContent = avail ? `Доступно обновление ${l.version}…` : "Проверить обновления";
    const parts = [];
    if (serverMeta) parts.push(`сервер ${serverMeta.version}`);
    if (Native && appVer) parts.push(`приложение ${appVer}`);
    let text = parts.length ? "Версия: " + parts.join(", ") : "";
    if (l && l.version && !avail) text += (text ? " — последняя" : "Установлена последняя версия");
    const day = store.get("updDay", "");
    if (day) text += `${text ? ". " : ""}Проверено ${day.split("-").reverse().join(".")}`;
    if (err) text += `${text ? ". " : ""}Проверка не удалась: ${err}`;
    if (Native && appVer && serverMeta && verNum(appVer).join(".") !== verNum(serverMeta.version).join(".")) text += ". Версии сервера и приложения разные";
    line.textContent = text;
    line.hidden = !text;
  }
  // окно «Обновление BookReader X»: что обновить, что нового, кнопки «Скачать» / «Установить»
  async function updatesDialog() {
    const l = store.get("updLatest", null);
    if (!l || !l.version) return;
    const srv = srvBehind(l), app = appBehind(l);
    const rows = [];
    if (serverMeta) rows.push(`<li>Сервер: <b>${esc(serverMeta.version)}</b>${srv ? ` → <b>${esc(l.version)}</b>` : " — последняя"}</li>`);
    if (Native && appVer) rows.push(`<li>Приложение: <b>${esc(appVer)}</b>${app ? ` → <b>${esc(l.version)}</b>` : " — последняя"}</li>`);
    let html = `<ul>${rows.join("")}</ul>`;
    if (app) html += `<p class="upd-hint">«Скачать» откроет браузер. Когда файл загрузится, откройте его — Android установит новую версию
      поверх старой; книги, озвучка и настройки сохранятся.</p>`;
    if (srv && !serverMeta.here) html += `<p class="upd-hint">Сервер обновляется на компьютере с сервером: откройте там читалку
      в браузере (Настройки → «Доступно обновление») или запустите update.bat.</p>`;
    if (srv && serverMeta.here) html += `<p class="upd-hint">Сервер остановится примерно на минуту и запустится снова; если что-то пойдёт
      не так, прежняя версия вернётся сама.</p>`;
    if (l.notes) html += `<details class="upd-notes"${l.notes.length < 400 ? " open" : ""}><summary>Что нового в ${esc(l.version)}</summary><pre>${esc(l.notes)}</pre></details>`;
    if (l.url) html += `<p class="upd-hint"><a href="${esc(l.url)}" target="_blank" rel="noopener" class="upd-link">Подробнее о выпуске — на GitHub</a></p>`;
    const buttons = [{ label: "Закрыть", value: null }];
    if (srv && serverMeta.here) buttons.push({ label: "Установить на сервер", primary: !app, value: "srv" });
    if (app) buttons.push({ label: `Скачать${l.apkSize ? " (" + fmtSize(l.apkSize) + ")" : ""}`, primary: true, value: "apk" });
    const shown = ask(`Обновление BookReader ${l.version}`, html, buttons);
    const link = askEl.body.querySelector(".upd-link");
    if (link && Native) link.onclick = (e) => { e.preventDefault(); Native.openUrl(l.url).catch(() => {}); };   // в приложении — внешний браузер
    const act = await shown;
    if (act === "apk") { try { await Native.openUrl(l.apk); } catch (e) { toast("Не получилось: " + e.message, 4000); } }
    if (act === "srv") installServerUpdate(true);
  }
  async function installServerUpdate(confirmed) {
    const l = store.get("updLatest", null);
    const ok = confirmed || await ask("Обновить сервер?", `<p>Будет установлена версия <b>${esc(l.version)}</b> с GitHub.</p>
      <p>Откроется окно обновления; сервер остановится на минуту и запустится снова — чтение и загрузка озвучки прервутся.
      Если что-то пойдёт не так, прежняя версия вернётся сама.</p>`,
      [{ label: "Отмена", value: null }, { label: "Обновить", primary: true, value: 1 }]);
    if (!ok) return;
    try {
      const r = await fetch("api/update/install", { method: "POST", headers: { "Content-Type": "application/json", "X-BookReader-Update": "1" }, body: "{}" });
      if (!r.ok) throw new Error(await httpError(r, "update"));
    } catch (e) { return toast("Не получилось запустить обновление: " + netMessage(e), 5000); }
    const was = serverMeta.version;
    ask("Обновляю сервер…", `<p>Идёт обновление до ${esc(l.version)} — следите за окном обновления на этом ПК.</p>
      <p>Когда сервер запустится снова, страница перезагрузится сама.</p>`, [{ label: "Скрыть", value: null }]);
    const t0 = Date.now();
    const poll = setInterval(async () => {
      try {
        const r = await fetch("api/ping", { cache: "no-store" });
        const p = await r.json();
        if (p.version && p.version !== was) { clearInterval(poll); location.reload(); }
      } catch (_) {}
      if (Date.now() - t0 > 15 * 60000) clearInterval(poll);
    }, 3000);
  }
  // доступно обновление — окно с подробностями; иначе — проверить сейчас
  $("btnUpdCheck").onclick = async () => {
    const l = store.get("updLatest", null);
    if (l && (srvBehind(l) || appBehind(l))) return updatesDialog();
    await checkUpdates(true);
  };

  // ---------- сервер ----------
  async function loadServerInfo() {
    if (autonomous()) {              // сервера нет: голоса не нужны, плашек нет, версия сервера неизвестна
      serverMeta = null;
      setWarn(null);
      renderUpdates();
      return;
    }
    try {
      let info;
      if (Native) {
        info = await Native.serverInfo();
        if (!info || !info.speakers) throw new Error(info && info.error || "нет ответа");
      } else {
        const r = await fetch("api/info");
        if (!r.ok) throw new Error(await httpError(r, "info"));
        info = await r.json();
      }
      el.voice.innerHTML = "";
      info.speakers.forEach((s) => {
        const o = document.createElement("option");
        o.value = s.id; o.textContent = s.name;
        el.voice.appendChild(o);
      });
      const want = settings.voice && info.speakers.some((s) => s.id === settings.voice) ? settings.voice : info.default;
      el.voice.value = want;
      offlineMode = !!(info.offline && info.manual);
      el.setServer.value = offlineMode ? "offline" : "online";
      if (offlineMode) setWarn(null);                      // сами выбрали «Без сервера» — не мешаем плашкой
      else if (info.offline) setWarn("unreachable", info.error);
      else setWarn(null);
      if (info.device === "fake") toast("Сервер в тестовом режиме (--fake): вместо голоса тон");
      serverMeta = !info.offline && info.version ? { version: info.version, repo: info.update_repo, here: !!info.update_here } : null;
      renderUpdates();
    } catch (e) {
      el.voice.innerHTML = '<option value="aidar">Айдар — мужской</option>';
      setWarn("down", netMessage(e));
      serverMeta = null;
      renderUpdates();
    }
  }

  // ---------- главы: поиск, если в книге нет оглавления (или оно неточное) ----------
  const tocAuto = document.getElementById("tocAuto");
  function renderTocTools() {
    if (!book) { tocAuto.hidden = true; return; }
    tocAuto.hidden = false;
    const empty = !el.tocList.childElementCount;
    if (empty) {
      tocAuto.innerHTML = `<p><b>В книге нет оглавления</b> — главы в файле не размечены.</p>
        <button class="set-btn primary" data-act="find">Найти главы автоматически…</button>
        <p class="set-hint">Ищет строки вида «Глава 1», «Часть II», «Пролог» и заголовки, набранные крупнее или жирнее
        основного текста. Перед применением покажет, что получилось; разметку можно убрать.</p>`;
    } else if (book.autoToc) {
      tocAuto.innerHTML = `<p class="set-hint">Главы размечены автоматически.
        <button class="link-btn" data-act="find">Изменить разметку…</button></p>`;
    } else {
      tocAuto.innerHTML = `<p class="set-hint">Оглавление неточное? <button class="link-btn" data-act="find">Разметить главы…</button></p>`;
    }
  }
  tocAuto.addEventListener("click", (e) => { if (e.target.closest("[data-act=find]")) chaptersDialog(); });

  async function chaptersDialog() {
    if (!book || !bookId) return;
    const id = bookId;
    act("поиск глав");
    toast("Ищу главы…", 8000);
    let found, meta;
    try {
      meta = await Library.get(id);
      const rec = await Library.getFile(id);
      if (!rec) throw new Error("файл книги не найден");
      const b = await Books.parseBuffer(rec.data, rec.name);   // заново: в открытой книге найденные главы уже стали заголовками
      found = Books.findChapters(b);
      releaseUrls(b);
    } catch (e) { toast("Не получилось: " + e.message, 5000); return; }
    el.toast.classList.remove("show");
    if (id !== bookId) return;
    const V = found.variants;
    const had = !!(meta && meta.chapters);
    if (!V.length) {
      await ask("Главы не найдены", `<p>В тексте нет ни строк вида «Глава 1», «Часть II», «Пролог», ни заголовков,
        набранных крупнее или жирнее основного текста.</p><p>Если главы в книге есть, проверьте файл: возможно, они
        оформлены как обычный текст.</p>`, had ? [{ label: "Убрать прежнюю разметку", value: "remove" }, { label: "Понятно", primary: true, value: 0 }] : [{ label: "Понятно", primary: true, value: 0 }])
        .then((v) => { if (v === "remove") saveChapters(id, null); });
      return;
    }
    const html = `<p>Выберите, что считать заголовками глав. Ниже — как будет выглядеть оглавление.
      Можно отметить несколько вариантов: крупный шрифт станет разделами, мельче — главами внутри них.</p>
      <div class="chap-vars">${V.map((v, k) => `<label class="chap-var"><input type="checkbox" data-k="${k}"${v.recommended || v.checked ? " checked" : ""}>
        <span><b>${esc(v.label)}</b> — ${v.count}<br><small>${esc(v.entries.slice(0, 3).map((e) => e.text).join(" · "))}</small></span></label>`).join("")}</div>
      <div class="chap-prev" id="chapPrev"></div>
      <p class="set-hint">Разметка ищется по тексту и оформлению и может ошибаться — проверьте список. Книга при этом не меняется:
      разметку можно изменить или убрать здесь же.</p>`;
    const buttons = [{ label: "Отмена", value: null }];
    if (had) buttons.push({ label: "Убрать разметку", value: "remove" });
    buttons.push({ label: "Применить", primary: true, value: "apply" });
    const pr = ask("Разметка глав", html, buttons);
    const body = askEl.body, applyBtn = askEl.actions.querySelector(`[data-i="${buttons.length - 1}"]`);
    let merged = [];
    const preview = () => {
      const sel = [...body.querySelectorAll(".chap-var input:checked")].map((c) => V[Number(c.dataset.k)])
        .sort((a, b) => (b.fs || 0) - (a.fs || 0));
      merged = Books.mergeChapters(sel);
      const box = body.querySelector("#chapPrev");
      box.innerHTML = merged.length
        ? `<div class="chap-prev-head">Оглавление: ${merged.length}</div>` + merged.slice(0, 200).map((e) =>
          `<div class="chap-prev-row" style="padding-left:${(e.level - 1) * 16 + 8}px">${esc(e.text)}</div>`).join("") +
          (merged.length > 200 ? `<div class="chap-prev-row more">…и ещё ${merged.length - 200}</div>` : "")
        : `<div class="chap-prev-row more">Ничего не выбрано</div>`;
      applyBtn.disabled = !merged.length;
    };
    body.querySelectorAll(".chap-var input").forEach((c) => (c.onchange = preview));
    preview();
    const v = await pr;
    if (id !== bookId) return;
    if (v === "remove") return saveChapters(id, null);
    if (v === "apply" && merged.length) return saveChapters(id, { v: 1, n: found.itemCount, list: merged.map((e) => [e.i, e.level]) });
  }
  async function saveChapters(id, chapters) {
    await Library.update(id, { chapters });
    if (id !== bookId) return;
    flushPos();
    forgetBook(id);
    toast(chapters ? `Главы размечены: ${chapters.list.length}. Перестраиваю книгу…` : "Разметка убрана. Перестраиваю книгу…", 8000);
    const ok = await requestOpen({ kind: "lib", id, force: true });
    if (ok) toast(chapters ? `Готово: ${chapters.list.length} глав в оглавлении` : "Разметка глав убрана");
  }

  // ---------- боковые панели: библиотека слева, оглавление справа ----------
  function openPanel(p) {
    closePanels(p);
    p.classList.add("open"); p.setAttribute("aria-hidden", "false"); el.scrim.classList.add("show");
    if (p === el.toc) { const a = el.tocList.querySelector("a.current"); if (a) a.scrollIntoView({ block: "center" }); }
    if (p === el.lib) { const i = sortedBooks().findIndex((m) => m.id === bookId); if (i >= 0) libVL.scrollTo(i); }
  }
  function closePanels(except) {
    [el.toc, el.lib].forEach((p) => { if (p !== except) { p.classList.remove("open"); p.setAttribute("aria-hidden", "true"); } });
    if (!except) el.scrim.classList.remove("show");
  }
  const togglePanel = (p) => (p.classList.contains("open") ? closePanels() : openPanel(p));

  // ---------- блокировка прокрутки страницы под панелями и окнами ----------
  // Открыта панель (библиотека, оглавление) или окно — книга под ними не прокручивается ни колесом, ни пальцем.
  // Положение в книге при этом сохраняется (overflow: hidden не сбрасывает прокрутку).
  function syncScrollLock() {
    const open = el.lib.classList.contains("open") || el.toc.classList.contains("open") ||
      !!document.querySelector('.modal:not([hidden])');
    document.documentElement.classList.toggle("scroll-lock", open);
  }
  {
    const mo = new MutationObserver(syncScrollLock);
    [el.lib, el.toc].forEach((p) => mo.observe(p, { attributes: true, attributeFilter: ["class"] }));
    document.querySelectorAll(".modal").forEach((m) => mo.observe(m, { attributes: true, attributeFilter: ["hidden"] }));
  }

  // ---------- свайпы панелей ----------
  // от левого края вправо — библиотека, от правого края влево — оглавление; обратный свайп закрывает.
  // Край — 40 px: самые крайние пиксели на Android с жестами занимает системное «назад».
  const EDGE = 40;
  let sw = null;            // текущий жест
  let swipeHandled = false; // жест уже использован панелью — постраничный режим его не листает
  const swipeBlocked = (t) =>
    !!document.querySelector('[aria-modal="true"]:not([hidden])') ||
    (t && t.closest && t.closest('input[type="range"], textarea, select, .dl-ch-list'));
  document.addEventListener("touchstart", (e) => {
    swipeHandled = false;
    if (e.touches.length !== 1 || swipeBlocked(e.target)) { sw = null; return; }
    const x = e.touches[0].clientX, y = e.touches[0].clientY;
    sw = { x, y, t: Date.now(), edge: x <= EDGE ? "left" : x >= window.innerWidth - EDGE ? "right" : null };
  }, { passive: true, capture: true });
  document.addEventListener("touchend", (e) => {
    const g = sw;
    sw = null;
    if (!g || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - g.x, dy = e.changedTouches[0].clientY - g.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5 || Date.now() - g.t > 900) return;
    const libOpen = el.lib.classList.contains("open"), tocOpen = el.toc.classList.contains("open");
    if (libOpen || tocOpen) {
      // открытую панель закрывает свайп «обратно»: библиотеку — влево, оглавление — вправо
      if ((libOpen && dx < 0) || (tocOpen && dx > 0)) {
        closePanels(); swipeHandled = true;
        if (e.cancelable) e.preventDefault();
      }
      return;
    }
    if (g.edge === "left" && dx > 0) { showSettings(false); openPanel(el.lib); swipeHandled = true; }
    else if (g.edge === "right" && dx < 0 && !el.btnToc.disabled) { openPanel(el.toc); swipeHandled = true; }
    // палец отпустили над затемнением — без этого «клик» после жеста сразу закрыл бы панель
    if (swipeHandled && e.cancelable) e.preventDefault();
  }, { capture: true });
  document.addEventListener("touchcancel", () => { sw = null; }, { capture: true });

  // ---------- долгие подвисания → журнал «Для разработчиков» в приложении ----------
  // Что было последним действием и сколько длилось — чтобы по журналу тестера понять причину.
  let lastAct = { what: "запуск", t: Date.now() };
  const act = (what) => { lastAct = { what, t: Date.now() }; };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < 400) continue;
        const line = `подвисание ${Math.round(e.duration)} мс; до этого: «${lastAct.what}» (${Date.now() - lastAct.t} мс назад); ` +
          `книга: ${segs.length} фраз, ${isPaged() ? "книжный" : "лента"}${playing ? ", идёт чтение" : ""}`;
        if (Native && Native.log) Native.log(line); else console.warn(line);
      }
    }).observe({ type: "longtask", buffered: false });
  } catch (_) { /* браузер без longtask */ }

  // Кнопки, на которые нажимают пальцем, срабатывают на отпускание (как свайп): без «клика» и фокуса.
  // В WebView на Android фокус на кнопке и синтетический клик на большой книге могли стоить секунды.
  function onTap(btn, fn, label) {
    let t0 = null, touchedAt = 0;
    btn.addEventListener("touchstart", (e) => { t0 = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
    btn.addEventListener("touchcancel", () => { t0 = null; });
    btn.addEventListener("touchend", (e) => {
      const s0 = t0; t0 = null;
      if (!s0 || swipeHandled) return;
      const t = e.changedTouches[0];
      if (Math.hypot(t.clientX - s0.x, t.clientY - s0.y) > 12) return;   // сдвинул палец — не нажатие
      if (e.cancelable) e.preventDefault();   // без синтетического click и фокуса
      touchedAt = Date.now();
      if (btn.disabled) return;
      act(label); fn();
    });
    btn.addEventListener("click", () => { if (Date.now() - touchedAt < 700 || btn.disabled) return; act(label); fn(); });   // мышь, клавиатура
  }

  // ---------- события ----------
  onTap(el.play, togglePlay, "плей/пауза");
  onTap(el.prev, () => (Audiobook.active ? Audiobook.skip(-15) : jump(cur - 1, playing)), "назад");
  onTap(el.next, () => (Audiobook.active ? Audiobook.skip(30) : jump(cur + 1, playing)), "вперёд");
  onTap(el.btnToc, () => togglePanel(el.toc), "кнопка оглавления");
  el.tocClose.onclick = () => closePanels();
  onTap(el.btnLib, () => { if (!el.lib.classList.contains("open")) showSettings(false); togglePanel(el.lib); }, "кнопка библиотеки");
  el.libClose.onclick = () => closePanels();
  el.scrim.onclick = () => closePanels();

  // ползунок: пока тянут — подсказка с главой; отпустили (или просто нажали) — переход (см. navigateTo),
  // а если промахнулись — «↩ Вернуться».
  el.seek.oninput = () => {
    if (Audiobook.active) return Audiobook.seekInput();
    const i = Number(el.seek.value);
    seekTip.textContent = `${chapterOf(i)} · ${pctOf(i)}%`;
    seekTip.hidden = false;
    const x = thumbX(i), half = seekTip.offsetWidth / 2, W = el.seek.parentElement.clientWidth;
    seekTip.style.left = Math.max(half + 4, Math.min(W - half - 4, x)) + "px";
  };
  el.seek.onchange = () => {
    if (Audiobook.active) return Audiobook.seekChange();
    seekTip.hidden = true;
    act("ползунок");
    navigateTo(Number(el.seek.value));
    updateSeekMark();
  };
  el.seek.addEventListener("pointerup", () => setTimeout(() => (seekTip.hidden = true), 300));
  el.seek.addEventListener("pointercancel", () => { seekTip.hidden = true; });

  el.voice.onchange = () => {
    settings.voice = el.voice.value; store.set("voice", settings.voice);
    if (Native) { Native.Player.setVoice(settings.voice); scheduleCoverage(); return; }
    if (playing) playFrom(cur); else prefetch();
  };
  el.rate.value = String(settings.rate);
  if (!el.rate.value) el.rate.value = "1";
  el.rate.onchange = () => { if (Audiobook.active) return Audiobook.setRate(Number(el.rate.value)); settings.rate = Number(el.rate.value); store.set("rate", settings.rate); audio.playbackRate = settings.rate; if (Native) Native.Player.setRate(settings.rate); };
  el.volume.value = settings.volume;
  el.volume.oninput = () => { audio.volume = Number(el.volume.value); settings.volume = audio.volume; store.set("volume", audio.volume); Audiobook.setVolume(audio.volume); };
  Audiobook.setVolume(settings.volume);

  // ---------- настройки (левая панель → «Настройки») ----------
  function setFontSize(px) {
    const anchor = isPaged() ? layoutAnchor() : null;
    settings.font = Math.max(12, Math.min(40, Number(px) || 20));
    store.set("font", settings.font); applyLook(); sizeSections();
    if (isPaged()) layoutPaged(anchor);
    else if (segs.length) scrollToSeg(cur, "start");
  }
  function setViewMode(v) {
    settings.view = v === "paged" ? "paged" : "scroll";
    store.set("view", settings.view);
    applyView();
  }
  el.setTheme.value = settings.theme;
  if (![...el.setFont.options].some((o) => Number(o.value) === settings.font)) {
    el.setFont.add(new Option(String(settings.font), String(settings.font)));
  }
  el.setFont.value = String(settings.font);
  el.setView.value = settings.view;
  el.setTheme.onchange = () => { settings.theme = el.setTheme.value; store.set("theme", settings.theme); applyLook(); };
  el.setFont.onchange = () => setFontSize(el.setFont.value);
  el.setView.onchange = () => setViewMode(el.setView.value);
  el.btnServer.onclick = () => { if (Native) Native.openSettings(); };

  // левая панель: список книг / настройки / каталог сервера
  function showView(v) {
    el.setPanel.hidden = v !== "settings";
    el.catPanel.hidden = v !== "catalog";
    el.libView.hidden = v !== "lib";
    el.btnSelect.hidden = v !== "lib";
    if (v !== "lib" && selecting) setSelecting(false);
    el.setBack.hidden = v === "lib";
    if (v === "lib") libTitle();
    else { el.libHeadTitle.textContent = v === "settings" ? "Настройки" : "Каталог сервера"; el.libKind.hidden = true; }
    el.btnHome.hidden = v !== "lib" || (!book && !Audiobook.active);
    if (v === "catalog") loadCatalog();
  }
  const showSettings = (on) => showView(on ? "settings" : "lib");
  el.btnOpenSettings.onclick = () => showView("settings");
  el.setBack.onclick = () => showView("lib");

  // клик по тексту — перейти к фрагменту (во время чтения — сразу читать оттуда), двойной клик — читать
  // фраза под курсором — даже если клик пришёлся на пробел между словами
  function segAt(e) {
    let s = e.target.closest && e.target.closest(".seg");
    if (s) return s;
    const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
    const n = r && r.startContainer;
    s = n && (n.nodeType === 1 ? n : n.parentElement);
    return s && s.closest ? s.closest(".seg") : null;
  }
  // касание фразы — только выбрать её (место чтения и прогресс не трогаем); ▶ или двойное касание — читать с неё
  // двойное касание распознаём сами: в WebView на Android событие dblclick приходит не всегда
  let lastTap = { i: -1, t: 0 }, lastRead = { i: -1, t: 0 }, textTapsOffUntil = 0;
  function suppressTextTaps(ms) { textTapsOffUntil = Date.now() + ms; lastTap = { i: -1, t: 0 }; }
  function readByDoubleTap(i) {
    if (!modeAllows("tts")) return;                  // автономный режим: двойное касание ничего не делает
    if (lastRead.i === i && Date.now() - lastRead.t < 600) return;   // dblclick после своего распознавания — второй раз не читаем
    lastRead = { i, t: Date.now() };
    window.getSelection().removeAllRanges();
    readFrom(i);
  }
  el.reader.addEventListener("click", (e) => {
    if (Date.now() < textTapsOffUntil) { lastTap = { i: -1, t: 0 }; return; }   // только что нажали кнопку поверх текста
    const s = segAt(e);
    if (!s || window.getSelection().toString()) return;
    const i = Number(s.dataset.i);
    const now = Date.now();
    const dbl = lastTap.i === i && now - lastTap.t < 400;
    lastTap = { i, t: now };
    // одно касание ничего не делает (держат телефон, листают); двойное — читать с этой фразы;
    // долгое нажатие — обычное выделение текста (копировать и т. п.)
    if (dbl) return readByDoubleTap(i);
    if (pick >= 0) setPick(-1);
    tapHint();
  });
  el.reader.addEventListener("dblclick", (e) => {
    if (Date.now() < textTapsOffUntil) return;
    const s = segAt(e);
    if (s) readByDoubleTap(Number(s.dataset.i));
  });

  el.drop.onclick = () => (Native ? nativePick() : el.file.click());   // блок виден только при перетаскивании (ПК)
  el.file.onchange = () => { if (el.file.files.length) addFiles(el.file.files); el.file.value = ""; };

  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging");
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  document.addEventListener("keydown", (e) => {
    if (!askEl.box.hidden && e.code !== "Escape") return; // открыт вопрос — клавиши читалки не работают
    if (Pron.isOpen() && askEl.box.hidden) { if (e.code === "Escape" && !e.target.matches("input, select, textarea")) Pron.back(); return; }
    if (e.target.matches("select, textarea, input:not([type=range]):not([type=file])")) return;
    if (e.target.matches("input") && e.code !== "Space") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.shiftKey && !/^Arrow/.test(e.code)) return;
    if (askEl.box.hidden && Audiobook.key(e)) return;   // открыта аудиокнига: пробел, ← → — её
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    else if (isPaged() && !e.shiftKey && (e.code === "ArrowRight" || e.code === "PageDown")) { e.preventDefault(); turn(1); }
    else if (isPaged() && !e.shiftKey && (e.code === "ArrowLeft" || e.code === "PageUp")) { e.preventDefault(); turn(-1); }
    else if (isPaged() && (e.code === "Home" || e.code === "End")) { e.preventDefault(); showSection(e.code === "Home" ? 0 : sections.length - 1, e.code === "End"); }
    else if (e.code === "ArrowRight") { e.preventDefault(); jump(cur + 1, playing); }
    else if (e.code === "ArrowLeft") { e.preventDefault(); jump(cur - 1, playing); }
    else if (e.code === "KeyP") setViewMode(settings.view === "paged" ? "scroll" : "paged");
    else if (e.code === "Escape") { if (!askEl.box.hidden) { if (askEl.box.dataset.closable) askCancel(); } else if (!el.dl.hidden) closeDl(); else closePanels(); }
    else if (e.code === "KeyT") { if (!el.btnToc.disabled) togglePanel(el.toc); }
    else if (e.code === "KeyL") togglePanel(el.lib);
  });

  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    const h = (a, f) => { try { ms.setActionHandler(a, f); } catch (_) {} };
    // аудиокнига (её экран открыт или она играет) — кнопки ей, иначе чтению вслух
    const m = (name, f) => (...a) => (Audiobook.mediaAction(name) ? undefined : f(...a));
    h("play", m("play", resume)); h("pause", m("pause", pause)); h("stop", m("stop", stop));
    h("previoustrack", m("previoustrack", () => jump(cur - 1, playing)));
    h("nexttrack", m("nexttrack", () => jump(cur + 1, playing)));
    h("seekbackward", m("seekbackward", () => {})); h("seekforward", m("seekforward", () => {}));
  }

  window.addEventListener("beforeunload", flushPos);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushPos(); });

  if (Native) {
    Object.assign(Native.handlers, {
      onSegment(i) { if (i >= 0 && i < segs.length && i !== cur && (playing || Date.now() >= holdPosUntil)) setPos(i); },
      onState(isPlaying, loading) {
        playing = isPlaying;
        setLoading(loading);
        updateUI();
      },
      async onError(msg) {
        setLoading(false);
        await refreshAudio();
        if (await offerDownloadedVoice()) return;
        toast("Озвучка: " + msg, 6000);
        loadServerInfo();
      },
      onEnded() { playing = false; setLoading(false); updateUI(); toast("Книга дочитана"); },
      onSleep() { sleepFired(true); },
      onServerChanged() { loadServerInfo(); },
      onAb(st) { Audiobook.onNativeState(st); },
      toast(msg) { toast(msg, 2000); },
      onBack() { return goBack() ? "handled" : "exit"; },
      onPreload(st) {
        if (!st) return;
        if (st.queue) onQueue(st.queue);
        if (!st.bookId) return;
        const was = mainRow(st.bookId);
        audioRows = audioRows.filter((r) => r.bookId !== st.bookId).concat(st.rows || []);
        updateAudioBadge(st.bookId);
        if (!el.dl.hidden && st.bookId === bookId) updateDl();
        if (st.bookId === bookId) scheduleCoverage();
        const now = mainRow(st.bookId);
        if (was && was.running && !(now && now.running)) {
          renderUsage();
          const name = (libCache.find((m) => m.id === st.bookId) || {}).title || "книги";
          if (now && now.error) toast(`Загрузка озвучки «${name}» остановлена: ${now.error}`, 6000);
          else if (now && now.total && now.done >= now.total) toast(`Озвучка книги «${name}» загружена — можно слушать без сервера`, 4000);
        }
      },
    });
    // вернулись в приложение — догоняем плеер, который играл в фоне
    document.addEventListener("visibilitychange", async () => {
      if (document.hidden || !segs.length) return;
      try {
        const st = await Native.Player.state();
        if (!st) return;
        if (st.index >= 0 && st.index < segs.length && st.index !== cur) setPos(st.index);
        playing = !!st.playing; setLoading(!!st.loading); updateUI();
      } catch (_) {}
    });
  }

  Audiobook.init({
    store, toast, ask, esc, fmtSize, Library, askAssemble, closePanels, refreshLibrary,
    hideToast: () => el.toast.classList.remove("show"),
    thumbnail: (src) => (Library.thumbnail ? Library.thumbnail(src) : null),
    pauseTts: () => { if (playing) pause(); },
    syncPlayerHeight, closeBook,
    openToc: () => openPanel(el.toc),
    el: { prev: el.prev, next: el.next, play: el.play, seek: el.seek, seekTip, statusMain: el.statusMain, statusSub: el.statusSub,
      rate: el.rate, sleepBtn, sleepLeft, tocList: el.tocList, btnToc: el.btnToc, title: el.title, author: el.author },
    // открыть аудиокнигу: текстовая книга закрывается (место сохранено), как при обычном переключении книг
    enter(meta, temp) {
      closeBook();
      window.scrollTo(0, 0);   // лента текстовой книги могла быть прокручена — обложка не должна уехать под шапку
      el.empty.hidden = true;
      if (!temp) store.set("lastBook", meta.id);
    },
    onOpened: () => renderLibrary(),
    onLeft: () => { el.rate.value = String(settings.rate); document.title = "BookReader"; },
    onProgress: (id, progress) => {
      const m = libCache.find((x) => x.id === id);
      if (m) m.progress = progress;
      updateLibProgress(id, progress);
    },
  });

  async function start() {
    applyView();
    updateUI();
    if (Native) {
      try { const m = await Native.call("GetMode"); if (m === "online" || m === "offline" || m === "autonomous") appMode = m; } catch (_) {}
      offlineMode = appMode !== "online";
      el.setServer.value = appMode;
      applyMode();
    }
    if (Native && (await firstRun()) === false) return;
    await loadServerInfo();
    await Library.migrateOld((f) => Books.parseFile(f));
    await refreshLibrary();
    await refreshAudio();
    if (Native) { try { onQueue(await Native.Audio.queue()); } catch (_) {} }
    // первый запуск за день — проверить выпуски на GitHub (в фоне); в автономном режиме — только вручную
    if (!autonomous()) checkUpdates(false).catch(() => {});
  }
  start();
})();
