/* Произношение 2.0 — данные личных правил (без интерфейса).
   Формат хранения v2:
     { v: 2,
       folders: [{ id, name, parent }],                    parent — id папки или null (корневая папка)
       rules:   [{ id, f, w, c, s, books, t }],             f — папка или null; t — время создания (новые сверху)
       opts:    { date_order } }
   Папка — только способ упорядочить правила: ничего не наследуется, у каждого правила своё «где применяется».
   Хранятся только полностью заполненные правила. Нативная часть приложения и сервер читают из rules лишь
   w, c, s, books — для них формат не изменился.
   Подключается в браузере (window.PronModel) и в node (tests/pron_model_test.js). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PronModel = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const VOWELS = "аеёиоуыэюяАЕЁИОУЫЭЮЯ";
  const MAX_W = 60, MAX_S = 200, MAX_NAME = 80;

  // та же проверка, что на сервере (ru_rules.check_say)
  function checkSay(s) {
    s = (s || "").trim();
    if (!s) return "пусто";
    if (/\d/.test(s)) return "цифры не принимаются — напишите словами";
    if (/[A-Za-z]/.test(s)) return "латиница не принимается — напишите русскими буквами";
    if (!/^[А-Яа-яЁё+,\- ]+$/.test(s)) return "можно только русские буквы, «ё», «+», запятая, пробел и дефис";
    if (s.includes("++")) return "два «+» подряд";
    if (new RegExp(`\\+(?![${VOWELS}])`).test(s)) return "«+» ставится перед ударной гласной";
    if (!/[А-Яа-яЁё]/.test(s)) return "нет букв";
    return "";
  }

  const cleanW = (w) => String(w == null ? "" : w).trim();
  // как ru_rules.tidy: без лишних пробелов, «так ,  как» → «так, как»
  const cleanS = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").replace(/(, )+/g, ", ").trim();
  const yo = (x) => x.replace(/ё/g, "е").replace(/Ё/g, "Е");
  const low = (x) => yo(x).toLowerCase();

  /** Ошибка правила текстом или "" — правило годится для сохранения и озвучки. */
  function ruleError(r) {
    const w = cleanW(r && r.w), s = cleanS(r && r.s);
    if (!w) return "Не указано слово";
    if (w.length > MAX_W) return `Слово длиннее ${MAX_W} символов`;
    if (!s) return "Не указано, как звучит";
    if (s.length > MAX_S) return `«Как звучит» длиннее ${MAX_S} символов`;
    const e = checkSay(s);
    return e ? "Как звучит: " + e : "";
  }
  const complete = (r) => !ruleError(r);

  /** Одно и то же слово? «е» = «ё»; регистр различается, только если у обоих правил включён «Аа». */
  function sameWord(a, b) {
    const x = cleanW(a.w), y = cleanW(b.w);
    return a.c && b.c ? yo(x) === yo(y) : low(x) === low(y);
  }
  /** Правило с тем же словом (кроме самого правила r) или null. */
  function conflict(data, r) {
    return data.rules.find((x) => x.id !== r.id && sameWord(x, r)) || null;
  }

  let seq = 0;
  const uid = () => Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

  const books = (b) => (Array.isArray(b) ? [...new Set(b.map(String))] : null);

  function empty() { return { v: 2, folders: [], rules: [], opts: {} }; }

  /** Любые сохранённые данные (v1 или v2) → v2. Неполные правила отбрасываются, правила без папки — наверх,
      папки с несуществующим родителем или зацикленные — наверх, повторы слов — остаётся первое (новее). */
  function migrate(raw) {
    const d = empty();
    if (!raw || typeof raw !== "object") return d;
    if (raw.opts && typeof raw.opts === "object") {
      if (raw.opts.date_order === "mdy" || raw.opts.date_order === "dmy") d.opts.date_order = raw.opts.date_order;
    }
    const v2 = raw.v === 2;
    if (v2 && Array.isArray(raw.folders)) {
      const ids = new Set();
      raw.folders.forEach((f) => {
        if (!f || !f.id || ids.has(String(f.id))) return;
        const name = String(f.name || "").trim().slice(0, MAX_NAME);
        if (!name) return;
        ids.add(String(f.id));
        d.folders.push({ id: String(f.id), name, parent: f.parent == null ? null : String(f.parent) });
      });
      d.folders.forEach((f) => { if (f.parent !== null && !ids.has(f.parent)) f.parent = null; });
      // разорвать циклы
      d.folders.forEach((f) => {
        const seen = new Set([f.id]);
        for (let p = f.parent; p !== null; p = parentOf(d, p)) {
          if (seen.has(p)) { f.parent = null; break; }
          seen.add(p);
        }
      });
    }
    const fids = new Set(d.folders.map((f) => f.id));
    const list = Array.isArray(raw.rules) ? raw.rules : [];
    const now = Date.now();
    list.forEach((r, i) => {
      if (!r || typeof r !== "object" || !complete(r)) return;
      const x = {
        id: r.id ? String(r.id) : uid(),
        f: v2 && r.f != null && fids.has(String(r.f)) ? String(r.f) : null,
        w: cleanW(r.w), c: !!r.c, s: cleanS(r.s), books: books(r.books),
        // v1: порядок массива — новые сверху; сохраняем его через время создания
        t: v2 && Number.isFinite(r.t) ? r.t : now - i,
      };
      if (d.rules.some((y) => y.id === x.id)) x.id = uid();
      if (conflict(d, x)) return;
      d.rules.push(x);
    });
    return d;
  }

  // ---------- папки ----------
  const folder = (d, id) => d.folders.find((f) => f.id === id) || null;
  function parentOf(d, id) { const f = folder(d, id); return f ? f.parent : null; }

  /** Путь от верхнего уровня до папки: [папка1, папка2, …] (пустой для верхнего уровня). */
  function path(d, id) {
    const out = [];
    for (let f = folder(d, id); f; f = f.parent === null ? null : folder(d, f.parent)) out.unshift(f);
    return out;
  }
  const pathText = (d, id) => (id === null || id === undefined ? "Корневая папка" : path(d, id).map((f) => f.name).join(" › "));

  /** id папки и всех вложенных в неё. */
  function subtree(d, id) {
    const out = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      d.folders.forEach((f) => { if (f.parent !== null && out.has(f.parent) && !out.has(f.id)) { out.add(f.id); grew = true; } });
    }
    return out;
  }
  const rulesIn = (d, id) => { const s = subtree(d, id); return d.rules.filter((r) => s.has(r.f)); };

  const byNew = (a, b) => (b.t || 0) - (a.t || 0);
  /** Содержимое уровня: папки (по имени), правила (новые сверху). */
  function level(d, id) {
    id = id === undefined ? null : id;
    return {
      folders: d.folders.filter((f) => f.parent === id).sort((a, b) => a.name.localeCompare(b.name, "ru")),
      rules: d.rules.filter((r) => r.f === id).sort(byNew),
    };
  }

  function folderError(d, name, parent, exceptId) {
    name = String(name || "").trim();
    if (!name) return "Не указано название";
    if (name.length > MAX_NAME) return `Название длиннее ${MAX_NAME} символов`;
    const twin = d.folders.find((f) => f.id !== exceptId && f.parent === parent && f.name.toLowerCase() === name.toLowerCase());
    return twin ? "Папка с таким названием здесь уже есть" : "";
  }

  /** Создать папку → id. Ошибка — исключение с текстом. */
  function addFolder(d, name, parent) {
    parent = parent === undefined ? null : parent;
    const e = folderError(d, name, parent);
    if (e) throw new Error(e);
    if (parent !== null && !folder(d, parent)) throw new Error("Папка не найдена");
    const f = { id: uid(), name: String(name).trim(), parent };
    d.folders.push(f);
    return f.id;
  }
  function renameFolder(d, id, name) {
    const f = folder(d, id);
    if (!f) throw new Error("Папка не найдена");
    const e = folderError(d, name, f.parent, id);
    if (e) throw new Error(e);
    f.name = String(name).trim();
  }
  /** Можно ли перенести папку id в to (не в себя и не во вложенную). */
  const canMoveFolder = (d, id, to) => to === null || !subtree(d, id).has(to);
  function moveFolder(d, id, to) {
    const f = folder(d, id);
    if (!f) throw new Error("Папка не найдена");
    if (!canMoveFolder(d, id, to)) throw new Error("Нельзя перенести папку в саму себя");
    if (f.parent === to) return;
    const e = folderError(d, f.name, to, id);
    if (e) throw new Error("В выбранной папке уже есть папка «" + f.name + "»");
    f.parent = to;
  }
  /** Удалить папку. mode: "all" — вместе с содержимым; "up" — содержимое на уровень выше;
      { to: id|null } — содержимое в другую папку. Совпадающие по имени вложенные папки объединяются. */
  function removeFolder(d, id, mode) {
    const f = folder(d, id);
    if (!f) return;
    if (mode === "all") {
      const s = subtree(d, id);
      d.rules = d.rules.filter((r) => !s.has(r.f));
      d.folders = d.folders.filter((x) => !s.has(x.id));
      return;
    }
    const to = mode === "up" ? f.parent : mode && mode.to !== undefined ? mode.to : f.parent;
    if (to !== null && subtree(d, id).has(to)) throw new Error("Нельзя перенести содержимое в удаляемую папку");
    d.rules.forEach((r) => { if (r.f === id) r.f = to; });
    d.folders.filter((x) => x.parent === id).forEach((x) => mergeInto(d, x, to));
    d.folders = d.folders.filter((x) => x.id !== id);
  }
  // переносит папку x в to; если там уже есть папка с тем же именем — сливает содержимое
  function mergeInto(d, x, to) {
    const twin = d.folders.find((y) => y.id !== x.id && y.parent === to && y.name.toLowerCase() === x.name.toLowerCase());
    if (!twin) { x.parent = to; return; }
    d.rules.forEach((r) => { if (r.f === x.id) r.f = twin.id; });
    d.folders.filter((y) => y.parent === x.id).forEach((y) => mergeInto(d, y, twin.id));
    d.folders = d.folders.filter((y) => y.id !== x.id);
  }

  // ---------- правила ----------
  /** Сохранить правило (новое или изменённое). Возвращает сохранённое правило.
      Ошибки — исключение: err.message — текст, err.conflict — правило с тем же словом. */
  function saveRule(d, r) {
    const e = ruleError(r);
    if (e) throw new Error(e);
    const f = r.f === undefined || r.f === null ? null : String(r.f);
    if (f !== null && !folder(d, f)) throw new Error("Папка не найдена");
    const x = { id: r.id || uid(), f, w: cleanW(r.w), c: !!r.c, s: cleanS(r.s), books: books(r.books) };
    const twin = conflict(d, x);
    if (twin) {
      const err = new Error(`Такое слово уже есть: «${twin.w} → ${twin.s}» (${pathText(d, twin.f)})`);
      err.conflict = twin;
      throw err;
    }
    const old = d.rules.find((y) => y.id === x.id);
    if (old) { Object.assign(old, x, { t: old.t }); return old; }
    x.t = Date.now();
    d.rules.push(x);
    return x;
  }
  function removeRule(d, id) { d.rules = d.rules.filter((r) => r.id !== id); }

  // ---------- групповая обработка: sel = { rules: [id], folders: [id] } ----------
  function selectedRules(d, sel) {
    const ids = new Set(sel.rules || []);
    (sel.folders || []).forEach((fid) => rulesIn(d, fid).forEach((r) => ids.add(r.id)));
    return d.rules.filter((r) => ids.has(r.id));
  }
  /** Задать «где применяется» всем выбранным правилам (books: null — во всех книгах). → сколько правил. */
  function setBooksFor(d, sel, b) {
    const list = selectedRules(d, sel);
    list.forEach((r) => { r.books = books(b); });
    return list.length;
  }
  /** Перенести выбранное в папку to: правила — в неё, папки — внутрь неё (со всем содержимым). */
  function moveSelected(d, sel, to) {
    (sel.folders || []).forEach((fid) => { if (!canMoveFolder(d, fid, to)) throw new Error("Нельзя перенести папку в саму себя"); });
    (sel.rules || []).forEach((id) => { const r = d.rules.find((x) => x.id === id); if (r) r.f = to; });
    (sel.folders || []).forEach((fid) => { const f = folder(d, fid); if (f && f.parent !== to) mergeInto(d, f, to); });
  }
  /** Удалить выбранное (папки — со всем содержимым). → сколько правил удалено. */
  function removeSelected(d, sel) {
    const n = selectedRules(d, sel).length;
    const gone = new Set();
    (sel.folders || []).forEach((fid) => subtree(d, fid).forEach((x) => gone.add(x)));
    const ids = new Set(sel.rules || []);
    d.rules = d.rules.filter((r) => !ids.has(r.id) && !gone.has(r.f));
    d.folders = d.folders.filter((f) => !gone.has(f.id));
    return n;
  }

  // ---------- поиск: без учёта регистра, «е» = «ё», «+» не мешает ----------
  function search(d, q) {
    const k = low(String(q || "").trim()).replace(/\+/g, "");
    if (!k) return [];
    return d.rules.filter((r) => low(r.w).includes(k) || low(r.s).replace(/\+/g, "").includes(k)).sort(byNew);
  }

  // ---------- для озвучки ----------
  /** Правила для книги bookId: [{ w, c, s }] (развёрнуто из всех папок). */
  function forBook(d, bookId) {
    return d.rules.filter((r) => complete(r) && (!r.books || (bookId && r.books.includes(bookId))))
      .map((r) => ({ w: r.w, c: !!r.c, s: r.s }));
  }

  // ---------- экспорт / импорт ----------
  function exportData(d) {
    return {
      bookreader: "pronunciation", version: 2,
      folders: d.folders.map((f) => ({ id: f.id, name: f.name, parent: f.parent })),
      rules: d.rules.slice().sort(byNew).map((r) => ({ f: r.f, w: r.w, c: r.c, s: r.s, books: r.books })),
      opts: { ...d.opts },
    };
  }

  /** Что сделает импорт файла (уже разобранного JSON), ничего не меняя:
      { add: [правило], replace: [{ old, now }], skipped: N, folders: [путь новой папки], opts }.
      Папки ищутся по пути из названий: существующие используются, недостающие будут созданы.
      Правило с уже существующим словом заменяет его (и переносится в папку из файла). */
  function planImport(d, file) {
    if (!file || typeof file !== "object" || !Array.isArray(file.rules)) throw new Error("это не файл правил произношения");
    const src = migrate({ v: file.version === 2 ? 2 : 1, folders: file.folders, rules: (file.rules || []).map((r) => (r && typeof r === "object" ? { ...r, t: undefined } : r)), opts: file.opts });
    const skipped = file.rules.length - src.rules.length;
    const names = (id) => path(src, id).map((f) => f.name);
    const plan = { add: [], replace: [], skipped, folders: [], opts: src.opts.date_order ? { date_order: src.opts.date_order } : null };
    const newFolders = new Set();
    const order = src.rules.slice().reverse();   // в файле новые сверху — добавляем от старых к новым
    order.forEach((r) => {
      const where = r.f === null ? [] : names(r.f);
      if (!findPath(d, where)) {
        for (let i = 1; i <= where.length; i++) {
          const p = where.slice(0, i);
          if (!findPath(d, p)) newFolders.add(p.join("\n"));
        }
      }
      const item = { w: r.w, c: r.c, s: r.s, books: r.books, path: where };
      const old = d.rules.find((x) => sameWord(x, item));
      if (old) {
        if (plan.replace.some((p) => p.old === old)) return;
        plan.replace.push({ old, now: item });
      } else if (!plan.add.some((x) => sameWord(x, item))) plan.add.push(item);
    });
    // пустые папки из файла тоже переносим
    src.folders.forEach((f) => {
      const p = names(f.id);
      if (!findPath(d, p)) for (let i = 1; i <= p.length; i++) if (!findPath(d, p.slice(0, i))) newFolders.add(p.slice(0, i).join("\n"));
    });
    plan.folders = [...newFolders].map((s) => s.split("\n"));
    return plan;
  }
  // папка по пути из названий (без учёта регистра) → id; [] — корневая папка (null); нет — undefined
  function findPath(d, names) {
    let cur = null;
    for (const n of names) {
      const f = d.folders.find((x) => x.parent === cur && x.name.toLowerCase() === n.toLowerCase());
      if (!f) return undefined;
      cur = f.id;
    }
    return cur === null ? (names.length ? undefined : null) : cur;
  }
  function ensurePath(d, names) {
    let cur = null;
    for (const n of names) {
      let f = d.folders.find((x) => x.parent === cur && x.name.toLowerCase() === n.toLowerCase());
      if (!f) { f = { id: uid(), name: n, parent: cur }; d.folders.push(f); }
      cur = f.id;
    }
    return cur;
  }
  /** Выполнить план импорта. → { added, replaced }. */
  function applyImport(d, plan) {
    plan.folders.forEach((p) => ensurePath(d, p));
    let t = Date.now();
    plan.add.forEach((r) => {
      d.rules.push({ id: uid(), f: ensurePath(d, r.path), w: r.w, c: r.c, s: r.s, books: books(r.books), t: t++ });
    });
    plan.replace.forEach(({ old, now }) => {
      const r = d.rules.find((x) => x.id === old.id);
      if (r) Object.assign(r, { f: ensurePath(d, now.path), w: now.w, c: now.c, s: now.s, books: books(now.books) });
    });
    if (plan.opts && plan.opts.date_order) d.opts.date_order = plan.opts.date_order;
    return { added: plan.add.length, replaced: plan.replace.length };
  }

  const clone = (d) => JSON.parse(JSON.stringify(d));

  return {
    checkSay, ruleError, complete, sameWord, conflict, migrate, empty, clone, uid,
    folder, path, pathText, subtree, rulesIn, level, folderError, addFolder, renameFolder, canMoveFolder, moveFolder, removeFolder,
    saveRule, removeRule, selectedRules, setBooksFor, moveSelected, removeSelected,
    search, forBook, exportData, planImport, applyImport, findPath,
  };
});
