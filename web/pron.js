/* Личные правила произношения (BookReader 1.2.0, «Произношение» 2.0 — данные в pron-model.js).
   Хранятся на этом устройстве (в браузере — localStorage, в приложении — ещё и в его настройках, чтобы
   их видела нативная озвучка) и уходят на сервер с каждым запросом озвучки — только те, что действуют
   для открытой книги. Сервер их не хранит. Формат правила: { id, f, w, c, s, books, t }:
     w — слово как в книге, c — учитывать регистр, s — как звучит, books — null (во всех книгах) или список id книг;
     f — папка (null — корневая папка), t — время создания. */
(function () {
  "use strict";
  const KEY = "fb2r:pron";
  const M = window.PronModel;

  function load() {
    try {
      const j = localStorage.getItem(KEY);
      if (j) return M.migrate(JSON.parse(j));
    } catch (_) {}
    return M.empty();
  }
  let data = load();
  const listeners = [];
  // приложение: если хранилище страницы очистилось, а в настройках приложения правила есть — берём их оттуда
  if (window.Native && !data.rules.length && !data.folders.length) {
    window.Native.getPref("pron").then((j) => {
      if (!j || data.rules.length || data.folders.length) return;
      try {
        data = M.migrate(JSON.parse(j));
        localStorage.setItem(KEY, JSON.stringify(data));
      } catch (_) {}
    }).catch(() => {});
  }

  const complete = M.complete;
  const checkSay = M.checkSay;

  /** Сохранить данные (v2). Принимает и { rules, opts } без папок — папки тогда остаются прежними.
      Неполные правила не сохраняются (Произношение 2.0). */
  async function save(next) {
    const src = next && next.v === 2 ? next : { v: 2, folders: data.folders, rules: (next && next.rules) || [], opts: (next && next.opts) || {} };
    data = M.migrate(src);
    const json = JSON.stringify(data);
    try { localStorage.setItem(KEY, json); } catch (_) {}
    // в приложении правила читает нативная озвучка — дожидаемся записи, прежде чем она возьмёт озвучку заново
    try { if (window.Native) await window.Native.setPref("pron", json); } catch (_) {}
    listeners.forEach((f) => { try { f(data); } catch (_) {} });
  }

  /** Что отправить серверу для книги id: { rules, opts } (пустые поля не отправляем). */
  function payload(bookId) {
    const out = {};
    const rules = M.forBook(data, bookId);
    if (rules.length) out.rules = rules;
    if (data.opts && data.opts.date_order && data.opts.date_order !== "dmy") out.opts = { date_order: data.opts.date_order };
    return out;
  }
  /** Отпечаток набора для книги — меняется, когда меняются действующие для неё правила (кэш озвучки). */
  function stamp(bookId) { return JSON.stringify(payload(bookId)); }

  // ---------- страница «Произношение» (2.0) ----------
  // ctx: { ask, askEl, askFinish, esc, toast, library: () => Promise<[{id,title}]>, catalog: () => [{id,title}],
  //        speak: async (text, payload) => Blob }
  // Возвращает промис: true — после закрытия страницы звучание изменилось (полученную озвучку надо обновить).
  let page = null;
  const isOpen = () => !!page;
  function back() { if (page) page.back(); return !!page; }

  function plural(n, one, few, many) {
    const a = n % 10, b = n % 100;
    return `${n} ${a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many}`;
  }
  const nRules = (n) => plural(n, "правило", "правила", "правил");
  const nFolders = (n) => plural(n, "папка", "папки", "папок");
  // что реально звучит — по этому решаем, обновлять ли озвучку (папки и порядок не важны)
  const effective = (d) => JSON.stringify([d.rules.map((r) => [r.w, !!r.c, r.s, r.books ? [...r.books].sort() : null]).sort(), d.opts || {}]);

  const HELP = `<details class="pr-help"><summary>Как записывать</summary>
    <ul>
      <li><b>+</b> перед ударной гласной: «игр+ок», «Да+эрон». Без «+» ударение поставит озвучка — проверьте кнопкой ▶.</li>
      <li>«е» и «ё» звучат как написано: «Королев» — через «е», «Королёв» — через «ё».</li>
      <li>Только русские буквы. Числа и латиницу — словами: «HP» → «эйч-п+и», «3» → «три».</li>
      <li>Запятая — короткая пауза: «т.к.» → «так, как».</li>
      <li><b>Аа</b> — только слово с заглавной: имя «Роза», но не цветок.</li>
      <li>Каждая форма слова — отдельное правило: «Тёма», «Тёму».</li>
      <li>Одно слово — одно правило: второе правило с тем же словом сохранить нельзя.</li>
    </ul></details>`;

  // перетаскивание — только там, где есть мышь (на телефоне — выбор и «Переместить…»)
  const canDrag = !!(window.matchMedia && window.matchMedia("(pointer: fine)").matches);

  async function dialog(ctx) {
    if (page) return false;
    const { esc } = ctx;
    const d = M.clone(data);
    const before = effective(d);
    let lib = [];
    try { lib = await ctx.library(); } catch (_) {}
    const cat = (ctx.catalog() || []).filter((c) => !lib.some((b) => b.id === c.id));
    const titleOf = (id) => (lib.find((b) => b.id === id) || cat.find((c) => c.id === id) || { title: "книга не найдена" }).title;

    let cur = null;           // открытая папка (null — корневая папка)
    let query = "";
    let selecting = false;
    const sel = { rules: new Set(), folders: new Set() };
    const selection = () => ({ rules: [...sel.rules], folders: [...sel.folders] });

    async function commit() {
      await save(d);
      render();
    }

    // ----- разметка страницы -----
    const root = document.createElement("div");
    root.className = "prp";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Произношение");
    root.innerHTML = `<div class="prp-card">
      <div class="panel-head prp-head">
        <button class="icon-btn prp-back" title="Назад" aria-label="Назад">‹</button>
        <span class="prp-title">Произношение</span>
        <button class="icon-btn prp-x" title="Закрыть" aria-label="Закрыть">✕</button>
      </div>
      <nav class="prp-crumbs" aria-label="Путь"></nav>
      <div class="prp-tools">
        <button class="set-btn prp-addf"><svg><use href="#i-plus"/></svg><span>Папка</span></button>
        <button class="set-btn primary prp-addr"><svg><use href="#i-plus"/></svg><span>Правило</span></button>
        <button class="icon-btn prp-select" title="Выбрать несколько" aria-label="Выбрать несколько"><svg><use href="#i-select"/></svg></button>
        <input type="search" class="prp-search" placeholder="Поиск по всем папкам" aria-label="Поиск правил">
      </div>
      <div class="prp-list"></div>
      <div class="sel-bar prp-selbar" hidden>
        <button class="sel-btn prp-g-done" title="Отменить выбор" aria-label="Отменить выбор"><svg><use href="#i-x"/></svg><span>Отмена</span></button>
        <span class="sel-count" aria-hidden="true"></span>
        <button class="sel-btn prp-all" title="Выбрать все" aria-label="Выбрать все"><svg><use href="#i-all"/></svg><span>Все</span></button>
        <button class="sel-btn prp-g-books" title="Где применяется…" aria-label="Где применяется" disabled><svg><use href="#i-books"/></svg><span>Книги</span></button>
        <button class="sel-btn prp-g-move" title="Переместить…" aria-label="Переместить" disabled><svg><use href="#i-move"/></svg><span>Переместить</span></button>
        <button class="sel-btn danger prp-g-del" title="Удалить выбранное" aria-label="Удалить выбранное" disabled><svg><use href="#i-trash"/></svg><span>Удалить</span></button>
      </div>
      <div class="prp-io"><button class="set-btn prp-export">Экспорт</button><button class="set-btn prp-import">Импорт</button>
        <input type="file" class="prp-file" accept=".json,application/json" hidden></div>
    </div>`;
    document.body.appendChild(root);
    const $q = (s) => root.querySelector(s);
    const list = $q(".prp-list"), crumbs = $q(".prp-crumbs"), search = $q(".prp-search");

    const whereTo = (id) => (id === null || id === undefined ? "в корневую папку" : `в «${M.pathText(d, id)}»`);

    // ----- список уровня -----
    function scopeText(r) { return !r.books ? "Все книги" : r.books.length ? `В ${plural(r.books.length, "книге", "книгах", "книгах")}` : "Нигде"; }

    function render() {
      // папка могла исчезнуть (удалили) — подняться до существующей
      while (cur !== null && !M.folder(d, cur)) cur = null;
      crumbs.innerHTML = "";
      const parts = [{ id: null, name: "Произношение" }].concat(M.path(d, cur));
      parts.forEach((f, i) => {
        if (i) crumbs.insertAdjacentHTML("beforeend", '<span class="prp-sep">›</span>');
        const b = document.createElement("button");
        const here = i === parts.length - 1 && !query;
        b.className = "prp-crumb" + (here ? " here" : "");
        if (!here) b.dataset.drop = f.id === null ? "" : f.id;     // сюда можно перетащить
        b.textContent = f.name;
        b.onclick = () => { query = ""; search.value = ""; go(f.id); };
        crumbs.appendChild(b);
      });
      if (query) crumbs.insertAdjacentHTML("beforeend", `<span class="prp-sep">›</span><span class="prp-crumb here">Поиск: «${esc(query)}»</span>`);

      list.innerHTML = "";
      let folders = [], rules = [];
      if (query) rules = M.search(d, query);
      else ({ folders, rules } = M.level(d, cur));
      if (!query && cur !== null) list.appendChild(upRow());
      folders.forEach((f) => list.appendChild(folderRow(f)));
      rules.forEach((r) => list.appendChild(ruleRow(r)));
      if (!folders.length && !rules.length) {
        list.insertAdjacentHTML("beforeend", query ? '<div class="prp-empty">Ничего не найдено.</div>'
          : cur === null && !d.folders.length
            ? '<div class="prp-empty">Личных правил пока нет. Добавьте слово, которое звучит неправильно, или папку для правил.</div>'
            : '<div class="prp-empty">Здесь пока пусто. Добавьте правило или папку.</div>');
      }
      // выбор: убрать из выбранного то, чего больше нет
      [...sel.rules].forEach((id) => { if (!d.rules.some((r) => r.id === id)) sel.rules.delete(id); });
      [...sel.folders].forEach((id) => { if (!M.folder(d, id)) sel.folders.delete(id); });
      root.classList.toggle("selecting", selecting);
      $q(".prp-selbar").hidden = !selecting;
      $q(".prp-io").hidden = selecting;            // как в библиотеке: внизу вместо «Экспорт / Импорт»
      $q(".prp-select").classList.toggle("on", selecting);
      $q(".prp-select").title = selecting ? "Закончить выбор" : "Выбрать несколько";
      updateSel();
    }
    function visible() {
      if (query) return { folders: [], rules: M.search(d, query) };
      return M.level(d, cur);
    }
    function updateSel() {
      const n = M.selectedRules(d, selection()).length, k = sel.folders.size;
      // «Выбрано: N» — в заголовке страницы (как в Telegram): в панели внизу ему не хватает места.
      // Если среди отмеченных есть папки — рядом, сколько правил это затронет (вместе с вложенными).
      $q(".prp-title").textContent = selecting ? `Выбрано: ${sel.rules.size + k}` + (k ? ` · ${nRules(n)}` : "") : "Произношение";
      const any = sel.rules.size + sel.folders.size > 0;
      $q(".prp-g-books").disabled = !n;
      $q(".prp-g-move").disabled = !any;
      $q(".prp-g-del").disabled = !any;
      const v = visible(), all = v.folders.length + v.rules.length;
      const on = v.folders.filter((f) => sel.folders.has(f.id)).length + v.rules.filter((r) => sel.rules.has(r.id)).length;
      const btn = $q(".prp-all"), allOn = all > 0 && on === all;
      btn.dataset.on = allOn ? "1" : "";
      btn.title = allOn ? "Снять выбор" : "Выбрать все";
      btn.querySelector("span").textContent = allOn ? "Снять" : "Все";
      btn.disabled = !all;
    }
    function check(kind, id, on) {
      const set = kind === "f" ? sel.folders : sel.rules;
      if (on) set.add(id); else set.delete(id);
      updateSel();
    }

    function upRow() {
      const parent = M.folder(d, cur) ? M.folder(d, cur).parent : null;
      const row = document.createElement("div");
      row.className = "prp-item prp-up";
      row.dataset.drop = parent === null ? "" : parent;
      row.innerHTML = `<button class="prp-open"><span class="prp-ico up" aria-hidden="true"></span>
        <span class="prp-main"><b>...</b><small>Наверх — ${esc(whereTo(parent))}</small></span></button>`;
      row.querySelector(".prp-open").onclick = () => go(parent);
      return row;
    }
    function folderRow(f) {
      const n = M.rulesIn(d, f.id).length, sub = d.folders.filter((x) => x.parent === f.id).length;
      const row = document.createElement("div");
      row.className = "prp-item prp-folder";
      row.dataset.kind = "f"; row.dataset.id = f.id; row.dataset.drop = f.id;
      if (canDrag) row.draggable = true;
      row.innerHTML = `<input type="checkbox" class="prp-check" aria-label="Выбрать папку"${sel.folders.has(f.id) ? " checked" : ""}>
        <button class="prp-open"><span class="prp-ico" aria-hidden="true"></span>
          <span class="prp-main"><b>${esc(f.name)}</b><small>${esc(nRules(n))}${sub ? " · " + esc(nFolders(sub)) : ""}</small></span></button>
        <button class="icon-btn prp-more" title="Действия с папкой" aria-label="Действия с папкой">⋯</button>`;
      const box = row.querySelector(".prp-check");
      box.onchange = () => check("f", f.id, box.checked);
      row.querySelector(".prp-open").onclick = () => {
        if (selecting) { box.checked = !box.checked; check("f", f.id, box.checked); return; }
        query = ""; search.value = ""; go(f.id);
      };
      row.querySelector(".prp-more").onclick = () => folderMenu(f);
      return row;
    }
    function ruleRow(r) {
      const row = document.createElement("div");
      row.className = "prp-item prp-rule";
      row.dataset.kind = "r"; row.dataset.id = r.id;
      if (canDrag) row.draggable = true;
      const where = query ? `<small class="prp-where">${esc(M.pathText(d, r.f))}</small>` : "";
      row.innerHTML = `<input type="checkbox" class="prp-check" aria-label="Выбрать правило"${sel.rules.has(r.id) ? " checked" : ""}>
        <button class="prp-open"><span class="prp-main"><span class="prp-ws"><b>${esc(r.w)}</b> → ${esc(r.s)}</span>
          <small>${r.c ? '<span class="prp-aa" title="Учитывать регистр">Аа</span> · ' : ""}${esc(scopeText(r))}</small>${where}</span></button>
        <button class="icon-btn prp-play" title="Прослушать" aria-label="Прослушать">▶</button>
        <button class="icon-btn prp-more" title="Действия с правилом" aria-label="Действия с правилом">⋯</button>`;
      const box = row.querySelector(".prp-check");
      box.onchange = () => check("r", r.id, box.checked);
      row.querySelector(".prp-more").onclick = () => ruleMenu(r);
      row.querySelector(".prp-open").onclick = () => {
        if (selecting) { box.checked = !box.checked; check("r", r.id, box.checked); return; }
        ruleModal(r);
      };
      row.querySelector(".prp-play").onclick = () => play(r);
      return row;
    }
    async function play(r) {
      if (!M.complete(r)) return;
      try {
        const blob = await ctx.speak(r.w, { rules: [{ w: r.w, c: !!r.c, s: r.s }] });
        const url = URL.createObjectURL(blob);
        const a = new Audio(url);
        a.onended = () => URL.revokeObjectURL(url);
        await a.play();
      } catch (e) { ctx.toast("Не получилось прослушать: " + (e.message || e), 4000); }
    }

    function go(id) { cur = id; render(); list.scrollTop = 0; }

    // ----- выбор долгим нажатием (касание; как в Telegram) -----
    if (window.longPress) window.longPress(list, ".prp-folder, .prp-rule", (item) => {
      const set = item.dataset.kind === "f" ? sel.folders : sel.rules, id = item.dataset.id;
      if (!selecting) { set.add(id); setSelecting(true); return; }
      if (set.has(id)) set.delete(id); else set.add(id);
      render();
    });

    // ----- перетаскивание мышью: правила и папки — на папку, «...» или звено пути -----
    let dragging = null;
    const dropTo = (e) => {
      const t = e.target.closest("[data-drop]");
      if (!t || !root.contains(t) || !dragging) return undefined;
      const to = t.dataset.drop || null;
      if (dragging.folders.some((id) => !M.canMoveFolder(d, id, to))) return undefined;   // в себя / во вложенную
      return { t, to };
    };
    const clearOver = () => root.querySelectorAll(".drop-over").forEach((x) => x.classList.remove("drop-over"));
    list.addEventListener("dragstart", (e) => {
      const item = e.target.closest(".prp-folder, .prp-rule");
      if (!item) return;
      const kind = item.dataset.kind, id = item.dataset.id;
      const inSel = selecting && (kind === "f" ? sel.folders : sel.rules).has(id);
      dragging = inSel ? selection() : { rules: kind === "r" ? [id] : [], folders: kind === "f" ? [id] : [] };
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", kind === "r" ? (d.rules.find((r) => r.id === id) || {}).w || "" : ""); } catch (_) {}
      setTimeout(() => item.classList.add("dragging"), 0);
    });
    list.addEventListener("dragend", () => { dragging = null; clearOver(); root.querySelectorAll(".dragging").forEach((x) => x.classList.remove("dragging")); });
    root.addEventListener("dragover", (e) => {
      const r = dropTo(e);
      clearOver();
      if (!r) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      r.t.classList.add("drop-over");
    });
    root.addEventListener("dragleave", (e) => { if (!root.contains(e.relatedTarget)) clearOver(); });
    root.addEventListener("drop", async (e) => {
      const r = dropTo(e);
      clearOver();
      if (!r) return;
      e.preventDefault();
      const what = dragging;
      dragging = null;
      try { M.moveSelected(d, what, r.to); } catch (err) { ctx.toast(err.message, 3500); return; }
      if (selecting) setSelecting(false);
      await commit();
      const n = what.rules.length + what.folders.length;
      ctx.toast((n > 1 ? `Перемещено: ${n} — ` : "Перемещено ") + whereTo(r.to), 2500);
    });

    // ----- «Назад» и закрытие -----
    let finish;
    const closed = new Promise((res) => (finish = res));
    function close() {
      root.remove();
      page = null;
      finish(effective(data) !== before);
    }
    page = {
      back() {
        if (!ctx.askEl.box.hidden) { if (ctx.askEl.box.dataset.closable) ctx.askCancel(); return; }   // сначала окно поверх
        if (query) { query = ""; search.value = ""; render(); return; }
        if (selecting) { setSelecting(false); return; }
        if (cur !== null) { go(M.folder(d, cur) ? M.folder(d, cur).parent : null); return; }
        close();
      },
    };
    $q(".prp-back").onclick = () => page.back();
    $q(".prp-x").onclick = () => close();

    // ----- поиск -----
    search.oninput = () => { query = search.value.trim(); render(); };
    search.addEventListener("keydown", (e) => { if (e.key === "Escape" && search.value) { e.stopPropagation(); search.value = ""; query = ""; render(); } });

    // ----- выбор -----
    function setSelecting(on) {
      selecting = on;
      if (!on) { sel.rules.clear(); sel.folders.clear(); }
      render();
    }
    $q(".prp-select").onclick = () => setSelecting(!selecting);
    $q(".prp-g-done").onclick = () => setSelecting(false);
    $q(".prp-all").onclick = (e) => {
      const add = !e.currentTarget.dataset.on;     // всё уже выбрано — снять
      const v = visible();
      v.folders.forEach((f) => (add ? sel.folders.add(f.id) : sel.folders.delete(f.id)));
      v.rules.forEach((r) => (add ? sel.rules.add(r.id) : sel.rules.delete(r.id)));
      render();
    };
    $q(".prp-g-books").onclick = async () => {
      const list = M.selectedRules(d, selection());
      const first = list[0];
      const books = await scopeModal(`Где применяется — ${nRules(list.length)}`, first ? first.books : null);
      if (books === undefined) return;
      const n = M.setBooksFor(d, selection(), books);
      await commit();
      ctx.toast(`Изменено: ${nRules(n)}`, 2500);
    };
    $q(".prp-g-move").onclick = async () => {
      const ex = new Set();
      sel.folders.forEach((id) => M.subtree(d, id).forEach((x) => ex.add(x)));
      const to = await pickFolder("Переместить выбранное", "Переместить", ex, cur);
      if (to === undefined) return;
      try { M.moveSelected(d, selection(), to); } catch (e) { ctx.toast(e.message, 3500); return; }
      setSelecting(false);
      await commit();
      ctx.toast("Перемещено " + whereTo(to), 2500);
    };
    $q(".prp-g-del").onclick = async () => {
      const n = M.selectedRules(d, selection()).length, k = sel.folders.size;
      const what = [n ? nRules(n) : "", k ? nFolders(k) : ""].filter(Boolean).join(" и ");
      const ok = await ctx.ask("Удалить выбранное?", `<p>Будет удалено: ${esc(what)}${k ? " (вместе со всем, что в них лежит)" : ""}. Отменить нельзя.</p>`,
        [{ label: "Отмена", value: null }, { label: "Удалить", primary: true, danger: true, value: 1 }]);
      if (!ok) return;
      M.removeSelected(d, selection());
      setSelecting(false);
      await commit();
    };

    // ----- окна (модальные, поверх страницы) -----
    let modalSeq = 0;
    function modal(title, html, guard) {
      const tok = ++modalSeq;
      const p = ctx.ask(title, html, [], { beforeClose: guard || null });
      const box = ctx.askEl.box;
      box.classList.add("pr-open");
      p.finally(() => { if (tok === modalSeq) box.classList.remove("pr-open"); });
      const body = ctx.askEl.body;
      return { p, body };
    }
    // предупреждение при выходе без сохранения (плашка вверху окна)
    function unsavedGuard(get, dirty) {
      let asking = null;
      return () => {
        if (!dirty()) return true;
        if (asking) return false;
        const body = get();
        return new Promise((resolve) => {
          const bar = body.querySelector(".pr-unsaved");
          bar.hidden = false;
          body.scrollTop = 0;
          asking = (v) => { asking = null; bar.hidden = true; resolve(v); };
          bar.querySelector(".pr-u-stay").onclick = () => asking(false);
          bar.querySelector(".pr-u-leave").onclick = () => asking(true);
        });
      };
    }
    const unsavedBar = (text) => `<div class="pr-unsaved" hidden><b>${esc(text)}</b>
      <div class="pr-u-btns"><button class="set-btn pr-u-stay">Вернуться</button><button class="set-btn danger pr-u-leave">Выйти без сохранения</button></div></div>`;

    // список папок для выбора (дерево по алфавиту), кроме exclude
    function folderOptions(selected, exclude) {
      const out = [`<option value=""${selected === null ? " selected" : ""}>Корневая папка</option>`];
      const walk = (parent, depth) => {
        M.level(d, parent).folders.forEach((f) => {
          if (exclude && exclude.has(f.id)) return;
          out.push(`<option value="${esc(f.id)}"${selected === f.id ? " selected" : ""}>${"   ".repeat(depth)}${esc(f.name)}</option>`);
          walk(f.id, depth + 1);
        });
      };
      walk(null, 1);
      return out.join("");
    }
    // блок «Где применяется»
    function scopeHtml(name, books) {
      const item = (b) => `<label class="pr-book"><input type="checkbox" value="${esc(b.id)}"${books && books.includes(b.id) ? " checked" : ""}> ${esc(b.title)}</label>`;
      return `<div class="pr-scope2"><div class="pr-label">Где применяется</div>
        <label class="pr-opt"><input type="radio" name="${name}" value="all"${books ? "" : " checked"}> Во всех книгах, включая новые</label>
        <label class="pr-opt"><input type="radio" name="${name}" value="some"${books ? " checked" : ""}> Только в выбранных книгах</label>
        <div class="pr-books"${books ? "" : " hidden"}>
          ${lib.length || cat.length ? "" : '<div class="pr-none">В библиотеке пока нет книг</div>'}
          ${lib.map(item).join("")}
          ${cat.length ? '<div class="pr-sub">Каталог сервера</div>' + cat.map(item).join("") : ""}
          ${(books || []).filter((id) => !lib.some((b) => b.id === id) && !cat.some((c) => c.id === id))
            .map((id) => item({ id, title: titleOf(id) })).join("")}
        </div></div>`;
    }
    function scopeWire(body, name, onChange) {
      const books = body.querySelector(".pr-books");
      const read = () => {
        const mode = body.querySelector(`input[name="${name}"]:checked`).value;
        return mode === "all" ? null : [...books.querySelectorAll("input:checked")].map((x) => x.value);
      };
      body.querySelectorAll(`input[name="${name}"]`).forEach((x) => (x.onchange = () => { books.hidden = x.value === "all"; onChange && onChange(); }));
      books.querySelectorAll("input").forEach((x) => (x.onchange = () => onChange && onChange()));
      return read;
    }

    // окно правила (r — существующее или null — новое в текущей папке)
    async function ruleModal(r) {
      const isNew = !r;
      const init = r ? { w: r.w, c: !!r.c, s: r.s, f: r.f, books: r.books ? [...r.books] : null }
        : { w: "", c: false, s: "", f: cur, books: null };
      const html = `<div class="pr pr-edit">
        ${unsavedBar("Изменения не сохранятся, если выйти сейчас: правило не запишется.")}
        <label class="pr-field"><span class="pr-label">Слово как в книге</span>
          <input class="pr-w" placeholder="например, гг" maxlength="60" value="${esc(init.w)}" autocomplete="off" autocapitalize="off"></label>
        <label class="pr-case"><input type="checkbox"${init.c ? " checked" : ""}><span><b>Аа</b> — учитывать регистр</span></label>
        <div class="pr-field"><span class="pr-label">Как звучит <small>(+ перед ударной гласной)</small></span>
          <div class="pr-line"><input class="pr-s" placeholder="например, главный герой" maxlength="200" value="${esc(init.s)}" autocomplete="off" autocapitalize="off" aria-label="Как звучит">
          <button class="icon-btn pr-play" title="Прослушать" aria-label="Прослушать">▶</button></div></div>
        <div class="pr-err" hidden></div>
        <label class="pr-field"><span class="pr-label">Папка</span><select class="pr-folder">${folderOptions(init.f)}</select></label>
        ${scopeHtml("prsc", init.books)}
        ${HELP}
        <div class="pr-confirm" hidden><span>Удалить правило «${esc(init.w)}»?</span>
          <button class="set-btn pr-no">Отмена</button><button class="set-btn danger pr-yes">Удалить</button></div>
        <div class="pr-foot">
          ${isNew ? "" : '<button class="set-btn danger pr-del">Удалить</button>'}
          <button class="set-btn pr-cancel">Отмена</button>
          <button class="set-btn primary pr-save" disabled>Сохранить</button>
        </div>
      </div>`;
      let body = null;
      const vals = () => ({
        id: r ? r.id : undefined,
        w: body.querySelector(".pr-w").value.trim(),
        c: body.querySelector(".pr-case input").checked,
        s: body.querySelector(".pr-s").value.replace(/\s+/g, " ").trim(),
        f: body.querySelector(".pr-folder").value || null,
        books: readScope(),
      });
      const same = (a, b) => a.w === b.w && a.c === b.c && a.s === b.s && a.f === b.f &&
        JSON.stringify(a.books && [...a.books].sort()) === JSON.stringify(b.books && [...b.books].sort());
      const dirty = () => {
        const v = vals();
        if (isNew) return !!(v.w || v.s);      // ничего не введено — закрыть молча
        return !same(v, init);
      };
      const m = modal(isNew ? "Новое правило" : "Правило", html, unsavedGuard(() => body, dirty));
      body = m.body;
      const w = body.querySelector(".pr-w"), s = body.querySelector(".pr-s"), err = body.querySelector(".pr-err");
      const saveBtn = body.querySelector(".pr-save");
      const readScope = scopeWire(body, "prsc", () => validate());
      let touched = !isNew;
      function validate() {
        const v = vals();
        let msg = "", twin = null;
        if (v.w || v.s) {
          msg = M.ruleError(v);
          if (!msg) {
            twin = M.conflict(d, { ...v, id: v.id || "\u0000" });
            if (twin) msg = `Такое слово уже есть: «${twin.w} → ${twin.s}» (${M.pathText(d, twin.f)})`;
          }
        }
        // пока пользователь вводит первое поле нового правила — не ругаемся на пустое второе
        const show = msg && (touched || twin || (v.s && M.checkSay(v.s)));
        err.hidden = !show;
        err.innerHTML = show ? esc(msg) + (twin ? ' <button class="link-btn pr-open-twin">Открыть его</button>' : "") : "";
        if (twin) err.querySelector(".pr-open-twin").onclick = () => { ctx.askFinish(null); ruleModal(twin); };
        s.classList.toggle("bad", !!(v.s && M.checkSay(v.s)));
        saveBtn.disabled = !!msg || !(v.w && v.s) || (!isNew && same(v, init));
      }
      // ошибки «не указано …» показываем, когда заполнены оба поля или после ▶ / «Сохранить», — не при потере
      // фокуса: иначе строка ошибки появляется в момент касания кнопки и сдвигает её из-под пальца
      w.oninput = () => { if (w.value.trim() && s.value.trim()) touched = true; validate(); };
      s.oninput = () => { if (w.value.trim() && s.value.trim()) touched = true; validate(); };
      body.querySelector(".pr-case input").onchange = validate;
      body.querySelector(".pr-folder").onchange = validate;
      body.querySelector(".pr-play").onclick = () => {
        const v = vals();
        if (M.ruleError(v)) { touched = true; validate(); return; }
        play(v);
      };
      body.querySelector(".pr-cancel").onclick = () => ctx.askCancel();
      saveBtn.onclick = async () => {
        try { M.saveRule(d, vals()); }
        catch (e) { touched = true; validate(); if (!err.textContent) { err.textContent = e.message; err.hidden = false; } return; }
        ctx.askFinish(true);
        await commit();
      };
      const confirm = body.querySelector(".pr-confirm");
      const del = body.querySelector(".pr-del");
      if (del) del.onclick = () => { confirm.hidden = false; confirm.scrollIntoView({ block: "nearest" }); };
      body.querySelector(".pr-no").onclick = () => { confirm.hidden = true; };
      body.querySelector(".pr-yes").onclick = async () => {
        M.removeRule(d, r.id);
        ctx.askFinish(true);
        await commit();
      };
      body.querySelectorAll(".pr-w, .pr-s").forEach((x) => x.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !saveBtn.disabled) { e.preventDefault(); saveBtn.click(); }
      }));
      validate();
      if (isNew) setTimeout(() => w.focus(), 30);
      await m.p;
    }

    // окно папки: создать (f = null) или переименовать
    async function folderModal(f) {
      const isNew = !f;
      const parent = f ? f.parent : cur;
      const init = f ? f.name : "";
      const html = `<div class="pr pr-edit">
        ${unsavedBar("Изменения не сохранятся, если выйти сейчас: папка не запишется.")}
        <label class="pr-field"><span class="pr-label">Название папки</span>
          <input class="pr-name" maxlength="80" value="${esc(init)}" placeholder="например, Классика" autocomplete="off"></label>
        <div class="pr-hint">${isNew ? "Папка будет создана в: " + esc(M.pathText(d, parent)) : "Папка лежит в: " + esc(M.pathText(d, parent))}</div>
        <div class="pr-err" hidden></div>
        <div class="pr-foot"><button class="set-btn pr-cancel">Отмена</button><button class="set-btn primary pr-save" disabled>Сохранить</button></div>
      </div>`;
      let body = null;
      const dirty = () => { const v = body.querySelector(".pr-name").value.trim(); return isNew ? !!v : v !== init; };
      const m = modal(isNew ? "Новая папка" : "Переименовать папку", html, unsavedGuard(() => body, dirty));
      body = m.body;
      const name = body.querySelector(".pr-name"), err = body.querySelector(".pr-err"), btn = body.querySelector(".pr-save");
      const validate = () => {
        const v = name.value.trim();
        const e = v ? M.folderError(d, v, parent, f ? f.id : undefined) : "";
        err.hidden = !e; err.textContent = e;
        btn.disabled = !v || !!e || (!isNew && v === init);
      };
      name.oninput = validate;
      name.addEventListener("keydown", (e) => { if (e.key === "Enter" && !btn.disabled) { e.preventDefault(); btn.click(); } });
      body.querySelector(".pr-cancel").onclick = () => ctx.askCancel();
      btn.onclick = async () => {
        try { if (isNew) M.addFolder(d, name.value, parent); else M.renameFolder(d, f.id, name.value); }
        catch (e) { err.hidden = false; err.textContent = e.message; return; }
        ctx.askFinish(true);
        await commit();
      };
      validate();
      setTimeout(() => name.focus(), 30);
      await m.p;
    }

    // выбор папки → id | null (корневая папка) | undefined (отмена)
    async function pickFolder(title, okLabel, exclude, selected) {
      const html = `<div class="pr pr-edit">
        <label class="pr-field"><span class="pr-label">Папка</span><select class="pr-folder">${folderOptions(selected === undefined ? null : selected, exclude)}</select></label>
        <div class="pr-err" hidden></div>
        <div class="pr-foot"><button class="set-btn pr-cancel">Отмена</button><button class="set-btn primary pr-save">${esc(okLabel)}</button></div>
      </div>`;
      const m = modal(title, html);
      const selEl = m.body.querySelector(".pr-folder");
      if (exclude && exclude.has(selected)) selEl.value = "";
      m.body.querySelector(".pr-cancel").onclick = () => ctx.askCancel();
      m.body.querySelector(".pr-save").onclick = () => ctx.askFinish({ to: selEl.value || null });
      const v = await m.p;
      return v && typeof v === "object" ? v.to : undefined;
    }
    // «Где применяется» для группы → books | undefined (отмена)
    async function scopeModal(title, books, whom) {
      const html = `<div class="pr pr-edit">
        <div class="pr-hint">Настройка заменит «где применяется» ${esc(whom || "у всех выбранных правил")}.</div>
        ${scopeHtml("prgsc", books)}
        <div class="pr-foot"><button class="set-btn pr-cancel">Отмена</button><button class="set-btn primary pr-save">Применить</button></div>
      </div>`;
      const m = modal(title, html);
      const read = scopeWire(m.body, "prgsc");
      m.body.querySelector(".pr-cancel").onclick = () => ctx.askCancel();
      m.body.querySelector(".pr-save").onclick = () => ctx.askFinish({ books: read() });
      const v = await m.p;
      return v && typeof v === "object" ? v.books : undefined;
    }

    // ----- меню «⋯» (компактный список; закрыть — ✕, фон, «Назад») -----
    async function menu(title, info, items) {
      const html = `<div class="pr-menu">${info ? `<div class="pr-hint">${info}</div>` : ""}
        ${items.map((it, i) => `<button class="pr-mi${it.danger ? " danger" : ""}" data-i="${i}">${esc(it.label)}</button>`).join("")}</div>`;
      const m = modal(title, html);
      ctx.askEl.box.classList.add("pr-small");
      ctx.askEl.box.classList.remove("pr-open");   // меню — по центру, как все меню и подтверждения (полей ввода нет)
      m.p.finally(() => ctx.askEl.box.classList.remove("pr-small"));
      m.body.querySelectorAll(".pr-mi").forEach((b) => (b.onclick = () => ctx.askFinish({ v: items[Number(b.dataset.i)].value })));
      const r = await m.p;
      return r && typeof r === "object" ? r.v : null;
    }
    async function ruleMenu(r) {
      const act = await menu(`${r.w} → ${r.s}`, esc(M.pathText(d, r.f)), [
        { label: "Изменить…", value: "edit" },
        { label: "Переместить…", value: "move" },
        { label: "Удалить…", value: "delete", danger: true },
      ]);
      if (act === "edit") return ruleModal(r);
      if (act === "move") {
        const to = await pickFolder(`Переместить «${r.w}»`, "Переместить", null, r.f);
        if (to === undefined || to === r.f) return;
        M.moveSelected(d, { rules: [r.id], folders: [] }, to);
        await commit();
        ctx.toast("Перемещено " + whereTo(to), 2500);
      }
      if (act === "delete") {
        const ok = await ctx.ask(`Удалить правило «${r.w}»?`, `<p>${esc(r.w)} → ${esc(r.s)}</p>`,
          [{ label: "Отмена", value: null }, { label: "Удалить", primary: true, danger: true, value: 1 }]);
        if (!ok) return;
        M.removeRule(d, r.id);
        await commit();
      }
    }
    async function folderMenu(f) {
      const n = M.rulesIn(d, f.id).length;
      const act = await menu(`Папка «${f.name}»`, `${esc(nRules(n))} · лежит ${esc(whereTo(f.parent))}`, [
        { label: "Открыть", value: "open" },
        { label: "Переименовать…", value: "rename" },
        { label: "Где применяется (все правила)…", value: "books" },
        { label: "Переместить…", value: "move" },
        { label: "Удалить…", value: "delete", danger: true },
      ]);
      if (act === "open") { query = ""; search.value = ""; return go(f.id); }
      if (act === "rename") return folderModal(f);
      if (act === "books") {
        if (!n) { ctx.toast("В папке нет правил", 2500); return; }
        const first = M.rulesIn(d, f.id)[0];
        const books = await scopeModal(`Где применяется — ${nRules(n)} в «${f.name}»`, first.books, "у всех правил папки (и вложенных папок)");
        if (books === undefined) return;
        const k = M.setBooksFor(d, { folders: [f.id] }, books);
        await commit();
        ctx.toast(`Изменено: ${nRules(k)}`, 2500);
      }
      if (act === "move") {
        const to = await pickFolder(`Переместить «${f.name}»`, "Переместить", M.subtree(d, f.id), f.parent);
        if (to === undefined || to === f.parent) return;
        try { M.moveFolder(d, f.id, to); } catch (e) { ctx.toast(e.message, 3500); return; }
        await commit();
        ctx.toast("Перемещено " + whereTo(to), 2500);
      }
      if (act === "delete") return deleteFolder(f);
    }
    async function deleteFolder(f) {
      const n = M.rulesIn(d, f.id).length, k = M.subtree(d, f.id).size - 1;
      if (!n && !k) {
        const ok = await ctx.ask(`Удалить папку «${f.name}»?`, "<p>Папка пустая.</p>",
          [{ label: "Отмена", value: null }, { label: "Удалить", primary: true, danger: true, value: 1 }]);
        if (!ok) return;
        M.removeFolder(d, f.id, "all");
        return commit();
      }
      const inside = [n ? nRules(n) : "", k ? (k === 1 ? "1 вложенная папка" : `вложенных папок: ${k}`) : ""].filter(Boolean).join(", ");
      const act = await menu(`Удалить папку «${f.name}»?`, `В папке: ${esc(inside)}. Что сделать с содержимым?`, [
        { label: `Перенести содержимое выше — ${whereTo(f.parent)}`, value: "up" },
        { label: "Перенести содержимое в папку…", value: "to" },
        { label: `Удалить вместе с содержимым (${nRules(n)})`, value: "all", danger: true },
      ]);
      if (!act) return;
      if (act === "to") {
        const to = await pickFolder(`Куда перенести содержимое «${f.name}»`, "Перенести и удалить папку", M.subtree(d, f.id), f.parent);
        if (to === undefined) return;
        M.removeFolder(d, f.id, { to });
      } else M.removeFolder(d, f.id, act);
      await commit();
      ctx.toast(act === "all" ? "Папка удалена" : "Папка удалена, содержимое перенесено", 2500);
    }

    $q(".prp-addr").onclick = () => ruleModal(null);
    $q(".prp-addf").onclick = () => folderModal(null);

    // ----- экспорт / импорт -----
    $q(".prp-export").onclick = () => {
      const blob = new Blob([JSON.stringify(M.exportData(d), null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "bookreader-произношение.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
    const file = $q(".prp-file");
    $q(".prp-import").onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files[0];
      file.value = "";
      if (!f) return;
      let plan;
      try { plan = M.planImport(d, JSON.parse(await f.text())); }
      catch (e) { ctx.toast("Файл не прочитан: " + e.message, 4000); return; }
      if (!plan.add.length && !plan.replace.length && !plan.folders.length && !plan.opts) {
        ctx.toast("В файле нет правил для импорта" + (plan.skipped ? ` (пропущено неполных: ${plan.skipped})` : ""), 4000);
        return;
      }
      // совпадающее правило (то же звучание, «Аа», книги и папка) — не замена, просто «уже есть»
      const where = (x) => x.now.path.join("\n").toLowerCase();
      const same = (x) => x.old.w === x.now.w && x.old.s === x.now.s && !!x.old.c === !!x.now.c &&
        JSON.stringify(x.old.books && [...x.old.books].sort()) === JSON.stringify(x.now.books && [...x.now.books].sort()) &&
        M.path(d, x.old.f).map((f) => f.name).join("\n").toLowerCase() === where(x);
      const changed = plan.replace.filter((x) => !same(x));
      const kept = plan.replace.length - changed.length;
      if (!plan.add.length && !changed.length && !plan.folders.length && !(plan.opts && plan.opts.date_order !== (d.opts.date_order || "dmy"))) {
        ctx.toast("Все правила из файла уже есть", 3500);
        return;
      }
      const lines = changed.slice(0, 50).map((x) => {
        const p = x.now.path.length ? x.now.path.join(" › ") : "Корневая папка";
        const moved = M.path(d, x.old.f).map((f) => f.name).join("\n").toLowerCase() !== where(x);
        const parts = [];
        if (x.old.w !== x.now.w || x.old.s !== x.now.s) parts.push(`${esc(x.old.w)} → ${esc(x.old.s)} <b>⇒</b> ${esc(x.now.w)} → ${esc(x.now.s)}`);
        else parts.push(`${esc(x.now.w)} → ${esc(x.now.s)}`);
        if (!!x.old.c !== !!x.now.c) parts.push(x.now.c ? "«Аа» включится" : "«Аа» выключится");
        if (JSON.stringify(x.old.books && [...x.old.books].sort()) !== JSON.stringify(x.now.books && [...x.now.books].sort()))
          parts.push("где применяется: " + (x.now.books ? (x.now.books.length ? `в ${plural(x.now.books.length, "книге", "книгах", "книгах")}` : "нигде") : "все книги"));
        if (moved) parts.push(`в папку «${esc(p)}»`);
        return `<li>${parts.join(" · ")}</li>`;
      }).join("");
      const html = `<ul class="pr-sum">
          <li>Добавится правил: <b>${plan.add.length}</b></li>
          <li>Заменится правил: <b>${changed.length}</b></li>
          ${kept ? `<li>Уже есть, без изменений: ${kept}</li>` : ""}
          <li>Новых папок: <b>${plan.folders.length}</b> (существующие папки не заменяются)</li>
          ${plan.skipped ? `<li>Пропущено неполных или повторяющихся в файле: ${plan.skipped}</li>` : ""}
          ${plan.opts && plan.opts.date_order && plan.opts.date_order !== (d.opts.date_order || "dmy") ? "<li>Формат дат будет взят из файла</li>" : ""}
        </ul>
        ${changed.length ? `<details class="pr-repl"${changed.length <= 10 ? " open" : ""}><summary>Что заменится</summary><ul>${lines}</ul>${changed.length > 50 ? `<div class="pr-hint">и ещё ${changed.length - 50}</div>` : ""}</details>` : ""}`;
      const ok = await ctx.ask("Импорт правил", html, [{ label: "Отмена", value: null }, { label: "Импортировать", primary: true, value: 1 }]);
      if (!ok) return;
      const res = M.applyImport(d, plan);
      await commit();
      ctx.toast(`Добавлено: ${res.added}, заменено: ${changed.length}`, 3500);
    };

    render();
    return closed;
  }

  window.Pron = { get: () => data, save, payload, stamp, checkSay, dialog, isOpen, back, onChange: (f) => listeners.push(f) };
})();
