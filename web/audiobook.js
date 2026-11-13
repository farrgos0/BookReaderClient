/* Плеер готовых аудиокниг (шаг 8). Аудиокнига открывается как обычная книга: та же шапка, оглавление (главы)
   и плеер внизу (⏮ ⏭ — назад 15 с / вперёд 30 с, ползунок — по текущей главе); в середине — обложка. Здесь же добавление.
   Звук: в браузере — элемент <audio> (части книги — куски сохранённого файла, Blob.slice); в приложении — системный
   плеер Android (Native.Ab: работает в фоне, уведомление, гарнитура). Работает в любом режиме, и в автономном.
   Позиция — секунды от начала книги (apos в карточке), progress — доля прослушанного.
   app.js подключает модуль через Audiobook.init(ctx). */
(function () {
  "use strict";
  const A = window.AudioMeta;
  let ctx = null;
  const $ = (id) => document.getElementById(id);
  const RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const SAVE_EVERY = 10000;

  // ---------- состояние ----------
  let cur = null;          // { id, meta, title, authors, cover, parts, chapters, starts, duration, temp, blob }
  let at = 0;              // позиция, секунды от начала книги
  let playing = false, loading = false;
  let savedAt = 0, lastSaved = -1;
  let dragging = false;    // тянут ползунок — не двигаем его по времени
  let sleep = null;        // браузер: { until } | { chapterEnd: индекс главы }; приложение — sleepLeft из состояния
  let nativeSleepLeft = 0; // приложение: сколько осталось (с), -1 — до конца главы
  const engine = () => (window.Native ? nativeEngine : browserEngine);

  const rate = () => { const r = Number(ctx.store.get("abRate", 1)); return RATES.includes(r) ? r : 1; };

  // ---------- книга ----------
  function load(meta, extra) {
    const info = meta.audio || {};
    const parts = info.parts || [];
    const starts = [];
    let t = 0;
    for (const p of parts) { starts.push(t); t += p.duration || 0; }
    return Object.assign({
      id: meta.id, meta, title: meta.title, authors: meta.authors || [], cover: meta.cover,
      parts, chapters: (info.chapters || []).slice().sort((a, b) => a.at - b.at), starts, duration: info.duration || t,
    }, extra || {});
  }
  const partOf = (t) => { let p = 0; for (let i = 0; i < cur.starts.length; i++) if (t >= cur.starts[i] - 0.001) p = i; return p; };
  const chapterOf = (t) => { let c = 0; for (let i = 0; i < cur.chapters.length; i++) if (t >= cur.chapters[i].at - 0.25) c = i; return c; };
  const chapterEnd = (c) => (c + 1 < cur.chapters.length ? cur.chapters[c + 1].at : cur.duration);
  const clampAt = (t) => Math.max(0, Math.min(cur.duration ? cur.duration - 0.5 : t, t));

  // ---------- звук в браузере ----------
  const browserEngine = (() => {
    const audio = new Audio();
    audio.preload = "auto";
    try { audio.preservesPitch = true; audio.mozPreservesPitch = true; audio.webkitPreservesPitch = true; } catch (_) {}
    let part = -1, url = null, wantPlay = false, pendingSeek = null;
    function setPart(p) {
      if (p === part && url) return false;
      if (url) URL.revokeObjectURL(url);
      const pr = cur.parts[p];
      url = URL.createObjectURL(cur.blob.slice(pr.off, pr.off + pr.size, pr.mime || A.mimeOf(pr.name)));
      part = p;
      audio.src = url;
      return true;
    }
    function place(t) {
      const p = partOf(t);
      const local = Math.max(0, t - cur.starts[p]);
      const fresh = setPart(p);
      if (fresh || audio.readyState < 1) pendingSeek = local;
      else audio.currentTime = local;
    }
    audio.addEventListener("loadedmetadata", () => {
      if (pendingSeek !== null) { try { audio.currentTime = pendingSeek; } catch (_) {} pendingSeek = null; }
      audio.playbackRate = rate();
      if (wantPlay) audio.play().catch(onPlayError);
    });
    audio.addEventListener("timeupdate", () => {
      if (!cur || part < 0 || pendingSeek !== null) return;
      tick(cur.starts[part] + audio.currentTime);
    });
    audio.addEventListener("playing", () => { loading = false; playing = true; render(); });
    audio.addEventListener("waiting", () => { loading = true; render(); });
    audio.addEventListener("pause", () => { if (!wantPlay) { playing = false; loading = false; render(); } });
    audio.addEventListener("ended", () => {
      if (!cur) return;
      if (part + 1 < cur.parts.length) { place(cur.starts[part + 1]); if (wantPlay) audio.play().catch(onPlayError); }
      else { wantPlay = false; ended(); }
    });
    audio.addEventListener("error", () => {
      if (!cur || !audio.src) return;
      wantPlay = false; playing = false; loading = false; render();
      const p = cur.parts[part];
      ctx.toast(`Не получилось воспроизвести «${p ? baseName(p.name) : cur.title}»: формат не поддерживается этим браузером или файл повреждён`, 6000);
    });
    function onPlayError(e) {
      if (e && e.name === "AbortError") return;
      wantPlay = false; playing = false; loading = false; render();
      if (e && e.name === "NotAllowedError") ctx.toast("Браузер не дал начать воспроизведение — нажмите ▶ ещё раз", 4000);
    }
    return {
      async open() { part = -1; if (url) URL.revokeObjectURL(url); url = null; audio.removeAttribute("src"); },
      play(t) {
        wantPlay = true; loading = true; render();
        // экран блокировки / системные кнопки браузера: название и обложка
        try {
          if ("mediaSession" in navigator && window.MediaMetadata)
            navigator.mediaSession.metadata = new MediaMetadata({ title: cur.title, artist: cur.authors.join(", "), artwork: cur.cover ? [{ src: cur.cover }] : [] });
        } catch (_) {}
        place(t);
        audio.playbackRate = rate();
        if (audio.readyState >= 1 && pendingSeek === null) audio.play().catch(onPlayError);
      },
      pause() { wantPlay = false; audio.pause(); playing = false; loading = false; render(); },
      seek(t) { place(t); },
      setRate(r) { audio.playbackRate = r; },
      setVolume(v) { audio.volume = Math.max(0, Math.min(1, v)); },
      sleep() {},             // браузер: таймер ведёт контроллер (tick)
      stop() { wantPlay = false; audio.pause(); audio.removeAttribute("src"); if (url) URL.revokeObjectURL(url); url = null; part = -1; },
      get native() { return false; },
    };
  })();

  // ---------- звук в приложении (Android) ----------
  const nativeEngine = (() => {
    let poll = 0;
    const N = () => window.Native.Ab;
    function startPoll() {
      clearInterval(poll);
      poll = setInterval(async () => {
        if (document.hidden || !cur) return;
        try { applyState(await N().state()); } catch (_) {}
      }, 500);
    }
    function applyState(st) {
      if (!st || !cur || st.bookId !== cur.id) return;
      const wasPlaying = playing;
      playing = !!st.playing; loading = !!st.loading;
      nativeSleepLeft = st.sleepLeft || 0;
      if (typeof st.at === "number" && !dragging) tick(st.at, true);
      if (st.error) { ctx.toast("Аудиокнига: " + st.error, 6000); }
      if (st.ended && wasPlaying) ended(true);
      if (wasPlaying && !playing) save(true);
      render();
    }
    return {
      async open(book) {
        await N().open({ id: book.id, title: book.title, authors: book.authors,
          parts: book.parts.map((p) => ({ off: p.off, size: p.size, duration: p.duration, mime: p.mime })),
          chapters: book.chapters.map((c) => ({ title: c.title, at: c.at })), at });
        startPoll();
        try { applyState(await N().state()); } catch (_) {}   // играла в фоне, пока страницу перезагружали
      },
      play(t) { loading = true; render(); N().play(t, rate()).catch((e) => ctx.toast("Аудиокнига: " + e.message, 5000)); },
      pause() { N().pause().catch(() => {}); playing = false; render(); },
      seek(t) { N().seek(t).catch(() => {}); },
      setRate(r) { N().setRate(r).catch(() => {}); },
      sleep(minutes, chEnd) { N().sleep(minutes, chEnd).catch(() => {}); },
      stop() { N().stop().catch(() => {}); clearInterval(poll); },
      applyState,
      get native() { return true; },
    };
  })();

  // ---------- ход воспроизведения ----------
  function tick(t, fromNative) {
    if (!cur) return;
    at = t;
    if (!fromNative && playing && sleep) {
      if (sleep.until && Date.now() >= sleep.until) return sleepFired();
      if (sleep.chapterEnd !== undefined && at >= chapterEnd(sleep.chapterEnd) - 0.3) return sleepFired();
    }
    if (Date.now() - savedAt > SAVE_EVERY) save();
    renderTime();
  }
  function sleepFired() {
    sleep = null;
    pause();
    ctx.toast("Таймер сна: пауза");
    render();
  }
  function ended(fromNative) {
    playing = false; loading = false;
    at = cur.duration;
    save(true);
    render();
    if (!fromNative || !document.hidden) ctx.toast("Аудиокнига прослушана до конца");
  }

  async function save(force) {
    if (!cur || cur.temp) return;
    if (!force && Math.abs(at - lastSaved) < 1) return;
    savedAt = Date.now();
    lastSaved = at;
    const book = cur, pos = at;      // после await книга может быть уже закрыта
    const progress = book.duration ? Math.min(1, pos / book.duration) : 0;
    book.meta.apos = pos; book.meta.progress = progress;
    try { await ctx.Library.update(book.id, { apos: pos, progress, openedAt: Date.now() }); } catch (_) {}
    ctx.onProgress(book.id, progress);
  }

  // ---------- управление ----------
  function play() {
    if (!cur) return;
    ctx.pauseTts();
    if (cur.duration && at >= cur.duration - 1) at = 0;     // дослушали — сначала
    engine().play(at);
    playing = true;
    render();
  }
  function pause() {
    if (!cur) return;
    engine().pause();
    playing = false; loading = false;
    save(true);
    render();
  }
  const toggle = () => (playing || loading ? pause() : play());
  function seekTo(t) {
    if (!cur) return;
    at = clampAt(t);
    engine().seek(at);
    renderTime();
    save(true);
  }
  const skip = (d) => seekTo(at + d);
  function goChapter(i) {
    if (!cur || !cur.chapters.length) return;
    i = Math.max(0, Math.min(cur.chapters.length - 1, i));
    seekTo(cur.chapters[i].at);
    if (sleep && sleep.chapterEnd !== undefined) sleep.chapterEnd = i;
  }
  function setRate(r) {
    ctx.store.set("abRate", r);
    engine().setRate(r);
    render();
  }

  async function sleepDialog() {
    const now = engine().native
      ? (nativeSleepLeft === -1 ? "пауза в конце главы" : nativeSleepLeft > 0 ? `пауза через ${Math.ceil(nativeSleepLeft / 60)} мин` : "")
      : sleep ? (sleep.until ? `пауза через ${Math.max(0, Math.ceil((sleep.until - Date.now()) / 60000))} мин` : "пауза в конце главы") : "";
    const opts = [15, 30, 45, 60, 90].map((m) => ({ label: m + " минут", value: m }));
    const v = await ctx.ask("Таймер сна", `<p>Воспроизведение встанет на паузу через выбранное время.</p>` + (now ? `<p><b>Сейчас:</b> ${now}.</p>` : ""),
      [...opts, { label: "До конца главы", value: "chapter" }, ...(now ? [{ label: "Выключить таймер", value: "off" }] : [])]);
    if (v === null || v === undefined || !cur) return;
    if (v === "off") {
      sleep = null; nativeSleepLeft = 0;
      engine().sleep(0, false);
      ctx.toast("Таймер сна выключен");
    } else if (v === "chapter") {
      sleep = { chapterEnd: chapterOf(at) };
      nativeSleepLeft = -1;
      engine().sleep(0, true);
      ctx.toast("Таймер сна: пауза в конце главы");
    } else {
      sleep = { until: Date.now() + v * 60000 };
      nativeSleepLeft = v * 60;
      engine().sleep(v, false);
      ctx.toast(`Таймер сна: пауза через ${v} мин`);
    }
    render();
  }

  // ---------- открыть / закрыть ----------
  // Аудиокнига открывается как обычная книга: текстовая закрывается, шапка, оглавление и плеер внизу — те же.
  // meta — карточка из библиотеки; temp — { blob } для прослушивания без добавления (браузер)
  async function open(meta, temp) {
    if (!meta.audio || !(meta.audio.parts || []).length) throw new Error("в карточке нет сведений об аудиокниге — удалите её и добавьте заново");
    if (cur && cur.id === meta.id) { ctx.closePanels(); return; }
    const blob = temp ? temp.blob : window.Native ? null : await ctx.Library.blob(meta.id);
    if (!window.Native && !blob) throw new Error("файл аудиокниги не найден в хранилище");
    ctx.enter(meta, !!temp);          // закрыть текстовую (и прежнюю аудиокнигу), включить вид аудиокниги
    sleep = null; nativeSleepLeft = 0;
    cur = load(meta, { temp: !!temp, blob });
    at = Math.min(meta.apos || 0, cur.duration);
    playing = false; loading = false; lastSaved = at;
    document.documentElement.classList.add("ab-mode");
    setBarIcons(true);
    renderStage();
    renderToc();
    renderBar();
    ctx.syncPlayerHeight();
    await engine().open(cur);
    if (!temp) ctx.Library.update(meta.id, { openedAt: Date.now() }).catch(() => {});
    if (at > 5) ctx.toast(`Продолжаем с ${A.fmtTime(at)}`, 2000);
    ctx.onOpened();
  }
  // закрыть аудиокнигу (открыли другую книгу, удалили её, закрыли всё): пауза, место сохранено
  function unload() {
    if (!cur) return;
    if (playing || loading) engine().pause();
    save(true);
    engine().stop();
    cur = null; playing = false; loading = false; sleep = null; nativeSleepLeft = 0;
    document.documentElement.classList.remove("ab-mode");
    document.body.classList.remove("playing", "loading");
    setBarIcons(false);
    el.stage.hidden = true;
    ctx.onLeft();
    ctx.syncPlayerHeight();
  }
  // книгу удалили из библиотеки
  function forget(id) { if (cur && cur.id === id) ctx.closeBook(); }
  function reset(id) {
    if (!cur || cur.id !== id) return;
    at = 0; lastSaved = -1;
    engine().seek(0);
    renderBar();
  }
  function rename(id, title, authors) {
    if (!cur || cur.id !== id) return;
    cur.title = title; cur.authors = authors;
    renderStage();
  }

  // ---------- вид: середина экрана, оглавление, плеер внизу (общий с читалкой) ----------
  let el = {};
  const baseName = (n) => String(n).split("/").pop().replace(/\.[^.]+$/, "");
  const fmtRate = (r) => String(r).replace(".", ",") + "×";

  // ⏮ ⏭ плеера читалки у аудиокниги — назад 15 с и вперёд 30 с
  function setBarIcons(on) {
    const set = (btn, icon, title) => { const u = btn.querySelector("use"); if (u) u.setAttribute("href", icon); btn.title = title; btn.setAttribute("aria-label", title); };
    if (on) { set(ctx.el.prev, "#i-back15", "Назад на 15 секунд (←)"); set(ctx.el.next, "#i-fwd30", "Вперёд на 30 секунд (→)"); }
    else { set(ctx.el.prev, "#i-prev", "Назад (←)"); set(ctx.el.next, "#i-next", "Вперёд (→)"); }
  }

  function renderStage() {
    if (!cur) return;
    el.stage.hidden = false;
    el.cover.innerHTML = cur.cover ? `<img src="${cur.cover}" alt="">` : `<div class="ab-ph"><svg><use href="#i-voice"/></svg></div>`;
    el.title.textContent = cur.title;
    el.author.textContent = cur.authors.join(", ") || "Автор не указан";
    const label = (cur.meta.formatLabel || "Аудио") + " · " + A.fmtDuration(cur.duration);
    ctx.el.title.textContent = cur.title;
    ctx.el.author.textContent = (cur.authors.join(", ") || "Автор не указан") + " · " + label;
    document.title = cur.title + " — BookReader";
  }

  function renderToc() {
    const list = ctx.el.tocList;
    list.innerHTML = "";
    const grp = document.createElement("div");
    grp.className = "tocgrp";
    cur.chapters.forEach((c, i) => {
      const a = document.createElement("a");
      a.href = "#";
      a.dataset.c = i;
      a.className = "ab-toc";
      a.innerHTML = `<span>${ctx.esc(c.title || `Глава ${i + 1}`)}</span><small>${A.fmtTime(c.at)}</small>`;
      a.onclick = (e) => { e.preventDefault(); ctx.closePanels(); goChapter(i); };
      grp.appendChild(a);
    });
    list.appendChild(grp);
    ctx.el.btnToc.disabled = false;
  }

  // плеер внизу: кнопки, ползунок по текущей главе, строка состояния, таймер сна
  function renderBar() {
    if (!cur) return;
    const E = ctx.el;
    document.body.classList.toggle("playing", playing);
    document.body.classList.toggle("loading", loading && playing);
    [E.play, E.prev, E.next, E.seek].forEach((b) => (b.disabled = false));
    E.play.title = playing ? "Пауза (пробел)" : "Слушать (пробел)";
    if (E.rate.value !== String(rate())) E.rate.value = String(rate());
    const sl = engine().native ? nativeSleepLeft : sleep ? (sleep.until ? Math.max(0, Math.ceil((sleep.until - Date.now()) / 1000)) : -1) : 0;
    E.sleepBtn.classList.toggle("on", !!sl);
    E.sleepLeft.hidden = !sl;
    E.sleepLeft.textContent = sl === -1 ? "гл." : sl ? Math.max(1, Math.ceil(sl / 60)) + "′" : "";
    E.sleepBtn.title = sl === -1 ? "Таймер сна: пауза в конце главы" : sl ? `Таймер сна: пауза через ${Math.ceil(sl / 60)} мин` : "Таймер сна";
    renderTime();
  }
  function renderTime() {
    if (!cur) return;
    const E = ctx.el;
    const c = chapterOf(at), ch = cur.chapters[c] || { title: cur.title, at: 0 };
    const cs = ch.at, ce = chapterEnd(c), len = Math.max(1, ce - cs);
    if (!dragging) {
      E.seek.max = 1000;
      E.seek.value = String(Math.round(((at - cs) / len) * 1000));
    }
    const name = ch.title || `Глава ${c + 1}`;
    E.statusMain.textContent = cur.chapters.length > 1 ? name : cur.title;
    const pct = cur.duration ? Math.min(100, Math.floor((at / cur.duration) * 100)) : 0;
    const left = Math.max(0, cur.duration - at) / rate();
    E.statusSub.textContent = `${A.fmtTime(at - cs)} / ${A.fmtTime(ce - cs)} · ${pct}% · осталось ${A.fmtDuration(left)}` +
      (rate() !== 1 ? ` при ${fmtRate(rate())}` : "") + (playing || loading ? "" : " · пауза");
    el.chapter.textContent = cur.chapters.length > 1 ? `Глава ${c + 1} из ${cur.chapters.length} · ${name}` : "";
    const old = E.tocList.querySelector("a.current");
    const now = E.tocList.querySelector(`a[data-c="${c}"]`);
    if (old !== now) { if (old) old.classList.remove("current"); if (now) now.classList.add("current"); }
    if (!engine().native && "mediaSession" in navigator) { try { navigator.mediaSession.playbackState = playing ? "playing" : "paused"; } catch (_) {} }
  }
  const render = () => renderBar();

  // ползунок: пока тянут — подсказка со временем в главе; отпустили — переход
  function seekInput() {
    if (!cur) return;
    dragging = true;
    const E = ctx.el;
    const c = chapterOf(at), cs = cur.chapters[c] ? cur.chapters[c].at : 0, ce = chapterEnd(c);
    const t = cs + (Number(E.seek.value) / 1000) * (ce - cs);
    E.seekTip.textContent = `${A.fmtTime(t - cs)} / ${A.fmtTime(ce - cs)}`;
    E.seekTip.hidden = false;
    const W = E.seek.parentElement.clientWidth, half = E.seekTip.offsetWidth / 2;
    const x = E.seek.offsetLeft + 8 + (Number(E.seek.value) / 1000) * (E.seek.clientWidth - 16);
    E.seekTip.style.left = Math.max(half + 4, Math.min(W - half - 4, x)) + "px";
  }
  function seekChange() {
    if (!cur) return;
    const E = ctx.el;
    const c = chapterOf(at), cs = cur.chapters[c] ? cur.chapters[c].at : 0, ce = chapterEnd(c);
    dragging = false;
    E.seekTip.hidden = true;
    seekTo(Math.min(ce - 0.5, cs + (Number(E.seek.value) / 1000) * (ce - cs)));
  }
  function setVolume(v) { browserEngine.setVolume(v); }

  function bind() {
    el = { stage: $("abStage"), cover: $("abCover"), title: $("abTitle"), author: $("abAuthor"), chapter: $("abChapter") };
    el.chapter.onclick = () => ctx.openToc();
    document.addEventListener("visibilitychange", () => { if (document.hidden) save(true); });
    window.addEventListener("beforeunload", () => save(true));
    // браузер: таймер сна — обновлять минуты на кнопке
    setInterval(() => { if (cur && sleep && sleep.until) renderBar(); }, 20000);
  }

  // кнопки гарнитуры / экрана блокировки в браузере — открытой аудиокниге
  function mediaAction(name) {
    if (!cur) return false;
    ({ play, pause, stop: pause, previoustrack: () => skip(-15), nexttrack: () => skip(30), seekbackward: () => skip(-15), seekforward: () => skip(30) }[name] || (() => {}))();
    return true;
  }

  // клавиши: пробел — ▶/⏸, ← → — 15 / 30 секунд
  function key(e) {
    if (!cur) return false;
    if (e.code === "Space") { e.preventDefault(); toggle(); return true; }
    if (e.code === "ArrowLeft") { e.preventDefault(); skip(-15); return true; }
    if (e.code === "ArrowRight") { e.preventDefault(); skip(30); return true; }
    return e.code === "KeyP" || e.code === "Home" || e.code === "End" || e.code === "PageUp" || e.code === "PageDown";
  }

  // ---------- добавление ----------
  // разделить выбранные файлы: аудиокниги и всё остальное (ZIP — по содержимому)
  async function split(files) {
    const audio = [], rest = [];
    for (const f of files) ((await A.isAudioBook(f.name, A.blobReader(f))) ? audio : rest).push(f);
    return { audio, rest };
  }
  async function readCover(book) {
    if (!book.cover) return null;
    const url = URL.createObjectURL(new Blob([book.cover.data], { type: book.cover.mime }));
    try { return await ctx.thumbnail(url); } finally { URL.revokeObjectURL(url); }
  }
  const progressToast = (what) => (f) => ctx.toast(`${what}… ${Math.floor(f * 100)}%`, 8000);

  // браузер: файлы аудио/ZIP → книги (одна или отдельные), спросить про хранение, открыть последнюю
  async function importBrowser(files, openIt = true) {
    let groups;
    const singles = files.filter((f) => A.isAudioName(f.name));
    if (singles.length > 1 && (await ctx.askAssemble(singles.length, true)) === "one")
      groups = [singles, ...files.filter((f) => !singles.includes(f)).map((f) => [f])];
    else groups = files.map((f) => [f]);
    let last = null;
    for (const g of groups) {
      try {
        let blob = g[0], name = g[0].name;
        if (g.length > 1 || (A.ext(name) === "zip" && (await A.zipNeedsRepack(A.blobReader(blob))))) {
          ctx.toast("Собираю аудиокнигу…", 8000);
          const parts = await A.collectParts(g);
          name = g.length > 1 ? A.packName(parts.map((p) => p.name)) : name;
          blob = await A.packZip(parts, progressToast("Собираю аудиокнигу"));
        }
        ctx.toast(`Читаю «${name}»…`, 8000);
        const book = await A.readBook(A.blobReader(blob), name);
        const cover = await readCover(book);
        const est = await ctx.Library.estimate();
        const free = est && est.quota ? est.quota - est.usage : 0;
        const v = await ctx.ask("Аудиокнига", `<p><b>${ctx.esc(book.title)}</b> · ${A.fmtDuration(book.duration)} · ${ctx.fmtSize(blob.size)}</p>
          <p class="set-hint">Хранилище браузера ограничено${free ? ` (свободно примерно ${ctx.fmtSize(free)})` : ""}. Можно слушать, не сохраняя книгу:
          тогда после перезагрузки страницы файл придётся выбрать снова.</p>`,
          [{ label: "Слушать без добавления", value: "temp" }, { label: "Добавить в библиотеку", value: "add", primary: true }]);
        if (!v) continue;
        if (v === "temp") {
          const meta = { id: "temp:" + name + ":" + blob.size, title: book.title, authors: book.authors, cover, format: "audio", audio: window.AudioCard.audioInfo(book), apos: 0 };
          last = { meta, temp: { blob } };
        } else {
          if (free && blob.size > free) throw new Error("не хватает места в хранилище браузера");
          const meta = await ctx.Library.addAudio(blob, name, book, cover);
          last = { meta };
        }
      } catch (e) {
        console.error(e);
        ctx.toast(`«${g[0].name}»: ${e.message}`, 5000);
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    await ctx.refreshLibrary();
    if (openIt && last) { ctx.closePanels(); await open(last.meta, last.temp); ctx.hideToast(); }
    return !!last;
  }

  // браузер: аудиокнига из каталога сервера — сразу в библиотеку (её и скачивали ради этого)
  async function addFromCatalog(blob, item) {
    const book = await A.readBook(A.blobReader(blob), item.name);
    const cover = await readCover(book);
    const est = await ctx.Library.estimate();
    const free = est && est.quota ? est.quota - est.usage : 0;
    if (free && blob.size > free) throw new Error("не хватает места в хранилище браузера");
    return ctx.Library.addAudio(blob, item.name, book, cover, item.id);
  }

  // приложение: файлы уже в библиотеке (C# скопировал их) → разобрать; несколько — собрать в одну книгу
  async function importNative(picked) {
    const L = ctx.Library;
    let items = picked;
    if (picked.length > 1 && picked.filter((p) => A.isAudioName(p.name)).length > 1 && (await ctx.askAssemble(picked.length, true)) === "one") {
      ctx.toast("Собираю аудиокнигу…", 30000);
      try {
        const packed = await L.packAudio(picked.map((p) => p.id), A.packName(picked.map((p) => p.name)));
        for (const p of picked) if (p.isNew && p.id !== packed.id) await L.remove(p.id).catch(() => {});
        items = [Object.assign(packed, { isNew: true })];
      } catch (e) { ctx.toast("Не получилось собрать аудиокнигу: " + e.message, 5000); return null; }
    }
    let lastId = null;
    for (const p0 of items) {
      let p = p0;
      try {
        let r = await L.reader(p.id);
        if (A.ext(p.name) === "zip" && (await A.zipNeedsRepack(r))) {
          ctx.toast("Перекладываю архив без сжатия…", 30000);
          const packed = await L.packAudio([p.id], p.name);
          if (p.isNew && packed.id !== p.id) await L.remove(p.id).catch(() => {});
          p = Object.assign(packed, { isNew: true });
          r = await L.reader(p.id);
        }
        const meta0 = await L.get(p.id);
        if (p.isNew || !meta0 || !meta0.audio) {
          ctx.toast(`Читаю «${p.name}»…`, 8000);
          const book = await A.readBook(r, p.name);
          await L.update(p.id, { title: book.title, authors: book.authors, format: "audio", formatLabel: window.AudioCard.audioLabel(book),
            cover: await readCover(book), audio: window.AudioCard.audioInfo(book), apos: 0 });
        }
        lastId = p.id;
      } catch (e) {
        console.error(e);
        if (p.isNew) await L.remove(p.id).catch(() => {});
        ctx.toast(`«${p.name}»: ${e.message}`, 5000);
        await new Promise((res) => setTimeout(res, 1200));
      }
    }
    await ctx.refreshLibrary();
    return lastId;
  }

  window.Audiobook = {
    init(c) { ctx = c; bind(); },
    open, unload, forget, reset, rename, mediaAction, key, play, pause, toggle, skip, sleepDialog, setRate, setVolume,
    seekInput, seekChange, renderBar,
    split, importBrowser, importNative, addFromCatalog,
    get active() { return !!cur; },
    get current() { return cur ? cur.id : null; },
    get playing() { return playing; },
    onNativeState: (st) => nativeEngine.applyState(st),
    // для проверок
    _state: () => ({ at, playing, loading, sleep, part: cur ? partOf(at) : -1, chapter: cur ? chapterOf(at) : -1 }),
  };
})();
