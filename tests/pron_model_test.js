// Проверка данных «Произношение» 2.0 (web/pron-model.js): node tests/pron_model_test.js
"use strict";
const assert = require("assert");
const path = require("path");
const M = require(path.join(__dirname, "..", "web", "pron-model.js"));

let n = 0, failed = 0;
function test(name, fn) {
  n++;
  try { fn(); console.log("ok   " + name); }
  catch (e) { failed++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); }
}
const throws = (fn, re) => assert.throws(fn, (e) => re.test(e.message));

// ---------- переход со старого формата ----------
test("v1: полные правила — наверх, неполные — удаляются, порядок сохраняется", () => {
  const d = M.migrate({ rules: [
    { id: "a", w: "гг", c: false, s: "главный герой", books: null },
    { id: "b", w: "", c: false, s: "пусто" },
    { id: "c", w: "HP", c: true, s: "", books: null },
    { id: "d", w: "т.к.", c: false, s: "так как 3" },
    { id: "e", w: "Селен", c: true, s: "Сел+ен", books: ["x1", "x1", 7] },
  ], opts: { date_order: "mdy" } });
  assert.deepStrictEqual(d.rules.map((r) => r.id), ["a", "e"]);
  assert.ok(d.rules.every((r) => r.f === null));
  assert.deepStrictEqual(d.rules[1].books, ["x1", "7"]);
  assert.strictEqual(d.opts.date_order, "mdy");
  assert.deepStrictEqual(M.level(d, null).rules.map((r) => r.id), ["a", "e"]);   // новые сверху, как было
});
test("v1: повтор слова — остаётся верхнее (новее)", () => {
  const d = M.migrate({ rules: [{ w: "гг", s: "главный герой" }, { w: "ГГ", s: "гэ гэ" }] });
  assert.strictEqual(d.rules.length, 1);
  assert.strictEqual(d.rules[0].s, "главный герой");
});
test("пустое и мусор → пустые данные", () => {
  for (const x of [null, "x", 5, {}, { rules: "x" }]) assert.deepStrictEqual(M.migrate(x), M.empty());
});
test("v2: битые папки — наверх, цикл разорван, правило в несуществующей папке — наверх", () => {
  const d = M.migrate({ v: 2, folders: [
    { id: "p", name: "А", parent: "q" }, { id: "q", name: "Б", parent: "p" },
    { id: "r", name: "В", parent: "нет" }, { id: "s", name: "  ", parent: null },
  ], rules: [{ id: "1", f: "нет", w: "гг", s: "гэ гэ", t: 5 }, { id: "2", f: "r", w: "мб", s: "может быть", t: 6 }] });
  assert.strictEqual(d.folders.length, 3);
  assert.ok(d.folders.some((f) => f.parent === null && (f.id === "p" || f.id === "q")));
  assert.strictEqual(M.folder(d, "r").parent, null);
  assert.strictEqual(d.rules.find((r) => r.id === "1").f, null);
  assert.strictEqual(d.rules.find((r) => r.id === "2").f, "r");
});

// ---------- одинаковые слова ----------
test("одинаковые слова: е=ё, регистр — только если «Аа» у обоих", () => {
  const S = (w, c) => ({ w, c });
  assert.ok(M.sameWord(S("Селен", false), S("селён", false)));
  assert.ok(M.sameWord(S("ГГ", true), S("гг", false)));
  assert.ok(!M.sameWord(S("ГГ", true), S("гг", true)));
  assert.ok(M.sameWord(S("Селён", true), S("Селен", true)));
  assert.ok(!M.sameWord(S("гг", false), S("гг.", false)));
});
test("сохранение: запрет одинакового слова с указанием папки", () => {
  const d = M.empty();
  const a = M.addFolder(d, "Ранобэ");
  const b = M.addFolder(d, "Серия X", a);
  M.saveRule(d, { f: b, w: "гг", s: "главный герой" });
  try { M.saveRule(d, { w: "ГГ", s: "гэ гэ" }); assert.fail("должно быть запрещено"); }
  catch (e) {
    assert.match(e.message, /Такое слово уже есть: «гг → главный герой» \(Ранобэ › Серия X\)/);
    assert.strictEqual(e.conflict.w, "гг");
  }
  M.saveRule(d, { w: "Роза", c: true, s: "р+оза" });
  M.saveRule(d, { w: "роза", c: true, s: "цвет+ок" });   // оба с «Аа» — разные слова
  throws(() => M.saveRule(d, { w: "РОЗА", s: "р" }), /уже есть/);
});
test("сохранение: изменение того же правила не считается повтором, время создания не меняется", () => {
  const d = M.empty();
  const r = M.saveRule(d, { w: "гг", s: "главный герой" });
  const t = r.t;
  const r2 = M.saveRule(d, { id: r.id, w: "Гг", s: "гл+авный гер+ой" });
  assert.strictEqual(d.rules.length, 1);
  assert.strictEqual(r2.t, t);
  assert.strictEqual(d.rules[0].s, "гл+авный гер+ой");
});
test("запятая в «как звучит» — можно, пробелы приводятся в порядок", () => {
  const d = M.empty();
  const r = M.saveRule(d, { w: "т.к.", s: "так ,  как" });
  assert.strictEqual(r.s, "так, как");
  assert.strictEqual(M.checkSay("так, как"), "");
  throws(() => M.saveRule(d, { w: "а", s: ", ," }), /нет букв/);
});
test("сохранение: неполное правило не сохраняется", () => {
  const d = M.empty();
  throws(() => M.saveRule(d, { w: "", s: "а" }), /Не указано слово/);
  throws(() => M.saveRule(d, { w: "а", s: " " }), /Не указано, как звучит/);
  throws(() => M.saveRule(d, { w: "а", s: "HP" }), /латиница/);
  throws(() => M.saveRule(d, { w: "а", s: "аб+в" }), /ударной/);
  throws(() => M.saveRule(d, { w: "а", s: "б", f: "нет" }), /Папка не найдена/);
  assert.strictEqual(d.rules.length, 0);
});

// ---------- папки ----------
function tree() {
  const d = M.empty();
  const ran = M.addFolder(d, "Ранобэ");
  const x = M.addFolder(d, "Серия X", ran);
  const y = M.addFolder(d, "Серия Y", ran);
  const deep = M.addFolder(d, "Том 1", x);
  M.saveRule(d, { f: ran, w: "гг", s: "главный герой" });
  M.saveRule(d, { f: x, w: "Даэрон", c: true, s: "Да+эрон" });
  M.saveRule(d, { f: deep, w: "HP", s: "эйч-п+и", books: ["b1"] });
  M.saveRule(d, { f: y, w: "мб", s: "может быть" });
  M.saveRule(d, { w: "т.е.", s: "то есть" });
  return { d, ran, x, y, deep };
}
test("папки: путь, вложенные, счёт правил", () => {
  const { d, ran, x, deep } = tree();
  assert.strictEqual(M.pathText(d, deep), "Ранобэ › Серия X › Том 1");
  assert.strictEqual(M.pathText(d, null), "Корневая папка");
  assert.strictEqual(M.rulesIn(d, ran).length, 4);
  assert.strictEqual(M.rulesIn(d, x).length, 2);
  assert.deepStrictEqual(M.level(d, ran).folders.map((f) => f.name), ["Серия X", "Серия Y"]);
  assert.deepStrictEqual(M.level(d, null).rules.map((r) => r.w), ["т.е."]);
});
test("папки: одинаковое название на одном уровне запрещено, на разных — можно", () => {
  const { d, ran, x } = tree();
  throws(() => M.addFolder(d, "ранобэ"), /уже есть/);
  throws(() => M.addFolder(d, "  "), /Не указано название/);
  M.addFolder(d, "Ранобэ", x);
  throws(() => M.renameFolder(d, x, "Серия Y"), /уже есть/);
  M.renameFolder(d, x, "Серия Икс");
  assert.strictEqual(M.folder(d, x).name, "Серия Икс");
  assert.ok(ran);
});
test("папки: нельзя перенести в себя или во вложенную", () => {
  const { d, ran, deep, y } = tree();
  throws(() => M.moveFolder(d, ran, deep), /саму себя/);
  throws(() => M.moveFolder(d, ran, ran), /саму себя/);
  M.moveFolder(d, deep, y);
  assert.strictEqual(M.pathText(d, deep), "Ранобэ › Серия Y › Том 1");
});
test("удаление папки вместе с содержимым", () => {
  const { d, x } = tree();
  M.removeFolder(d, x, "all");
  assert.deepStrictEqual(d.rules.map((r) => r.w).sort(), ["гг", "мб", "т.е."].sort());
  assert.ok(!d.folders.some((f) => f.name === "Серия X" || f.name === "Том 1"));
});
test("удаление папки: содержимое — на уровень выше", () => {
  const { d, ran, x, deep } = tree();
  M.removeFolder(d, x, "up");
  assert.strictEqual(d.rules.find((r) => r.w === "Даэрон").f, ran);
  assert.strictEqual(M.folder(d, deep).parent, ran);
  assert.strictEqual(d.rules.length, 5);
});
test("удаление папки: содержимое — в другую папку, одноимённые вложенные сливаются", () => {
  const { d, x, y, deep } = tree();
  const y1 = M.addFolder(d, "том 1", y);
  M.removeFolder(d, x, { to: y });
  assert.strictEqual(d.rules.find((r) => r.w === "Даэрон").f, y);
  assert.strictEqual(d.rules.find((r) => r.w === "HP").f, y1);   // «Том 1» слилась с «том 1»
  assert.ok(!M.folder(d, deep));
  throws(() => M.removeFolder(d, y, { to: y1 }), /удаляемую/);
});

// ---------- групповая обработка ----------
test("группа: «где применяется» для выбранных правил и папок (с вложенными)", () => {
  const { d, x } = tree();
  const gg = d.rules.find((r) => r.w === "гг");
  const n = M.setBooksFor(d, { rules: [gg.id], folders: [x] }, ["b2", "b3"]);
  assert.strictEqual(n, 3);
  assert.deepStrictEqual(d.rules.find((r) => r.w === "HP").books, ["b2", "b3"]);
  assert.strictEqual(d.rules.find((r) => r.w === "мб").books, null);
  M.setBooksFor(d, { folders: [x] }, null);
  assert.strictEqual(d.rules.find((r) => r.w === "HP").books, null);
});
test("группа: перенос и удаление выбранного", () => {
  const { d, ran, x, y } = tree();
  const te = d.rules.find((r) => r.w === "т.е.");
  M.moveSelected(d, { rules: [te.id], folders: [y] }, x);
  assert.strictEqual(te.f, x);
  assert.strictEqual(M.folder(d, y).parent, x);
  throws(() => M.moveSelected(d, { folders: [ran] }, y), /саму себя/);
  const gone = M.removeSelected(d, { folders: [x] });
  assert.strictEqual(gone, 4);
  assert.deepStrictEqual(d.rules.map((r) => r.w), ["гг"]);
});

// ---------- поиск ----------
test("поиск: без регистра, е=ё, по «как звучит» без «+»", () => {
  const { d } = tree();
  M.saveRule(d, { w: "Иван", c: true, s: "Ив+ан" });
  assert.deepStrictEqual(M.search(d, "иван").map((r) => r.w), ["Иван"]);
  assert.deepStrictEqual(M.search(d, "ИВАН").map((r) => r.w), ["Иван"]);
  assert.deepStrictEqual(M.search(d, "даэрон").map((r) => r.w), ["Даэрон"]);
  assert.deepStrictEqual(M.search(d, "героЙ").map((r) => r.w), ["гг"]);
  assert.deepStrictEqual(M.search(d, "  "), []);
});

// ---------- озвучка ----------
test("для озвучки: все папки развёрнуты, учитываются книги", () => {
  const { d } = tree();
  assert.deepStrictEqual(M.forBook(d, "b1").map((r) => r.w).sort(), ["HP", "Даэрон", "гг", "мб", "т.е."].sort());
  assert.ok(!M.forBook(d, "b9").some((r) => r.w === "HP"));
  assert.deepStrictEqual(Object.keys(M.forBook(d, "b1")[0]).sort(), ["c", "s", "w"]);
});

// ---------- экспорт / импорт ----------
test("экспорт → импорт в пустое: всё восстанавливается", () => {
  const { d } = tree();
  d.opts.date_order = "mdy";
  const file = JSON.parse(JSON.stringify(M.exportData(d)));
  const e = M.empty();
  const plan = M.planImport(e, file);
  assert.strictEqual(plan.add.length, 5);
  assert.strictEqual(plan.replace.length, 0);
  const res = M.applyImport(e, plan);
  assert.deepStrictEqual(res, { added: 5, replaced: 0 });
  assert.strictEqual(M.pathText(e, e.rules.find((r) => r.w === "HP").f), "Ранобэ › Серия X › Том 1");
  assert.deepStrictEqual(e.rules.find((r) => r.w === "HP").books, ["b1"]);
  assert.strictEqual(e.folders.length, 4);
  assert.strictEqual(e.opts.date_order, "mdy");
  // порядок «новые сверху» сохраняется
  assert.deepStrictEqual(M.level(e, null).rules.map((r) => r.w), M.level(d, null).rules.map((r) => r.w));
});
test("импорт: повторы заменяются, папки не дублируются, новые папки создаются", () => {
  const { d, ran } = tree();
  const other = M.empty();
  const r2 = M.addFolder(other, "ранобэ");          // то же название в другом регистре
  const z = M.addFolder(other, "Серия Z", r2);
  M.saveRule(other, { f: r2, w: "ГГ", s: "гэ гэ" });        // повтор «гг»
  M.saveRule(other, { f: z, w: "кмк", s: "как мне кажется" });
  M.saveRule(other, { w: "Пустое", s: "" === "" ? "п+усто" : "" });
  const file = JSON.parse(JSON.stringify(M.exportData(other)));
  file.rules.push({ w: "битое", s: "" });
  const plan = M.planImport(d, file);
  assert.strictEqual(plan.replace.length, 1);
  assert.strictEqual(plan.replace[0].old.s, "главный герой");
  assert.strictEqual(plan.replace[0].now.s, "гэ гэ");
  assert.deepStrictEqual(plan.add.map((r) => r.w).sort(), ["Пустое", "кмк"].sort());
  assert.deepStrictEqual(plan.folders, [["ранобэ", "Серия Z"]]);
  assert.strictEqual(plan.skipped, 1);
  const before = d.folders.length;
  M.applyImport(d, plan);
  assert.strictEqual(d.folders.length, before + 1);                  // «ранобэ» не создана заново
  const gg = d.rules.find((r) => M.sameWord(r, { w: "гг", c: false }));
  assert.strictEqual(gg.s, "гэ гэ");
  assert.strictEqual(gg.f, ran);
  assert.strictEqual(M.pathText(d, d.rules.find((r) => r.w === "кмк").f), "Ранобэ › Серия Z");
  assert.strictEqual(d.rules.filter((r) => M.sameWord(r, { w: "гг", c: false })).length, 1);
});
test("импорт: старый файл без папок — правила наверх; чужой файл — ошибка", () => {
  const { d } = tree();
  const plan = M.planImport(d, { bookreader: "pronunciation", version: 1, rules: [{ w: "спс", s: "спасибо" }, { w: "мб", s: "м+ожет быть" }] });
  assert.strictEqual(plan.add.length, 1);
  assert.deepStrictEqual(plan.add[0].path, []);
  assert.strictEqual(plan.replace.length, 1);
  M.applyImport(d, plan);
  assert.strictEqual(d.rules.find((r) => r.w === "спс").f, null);
  throws(() => M.planImport(d, { hello: 1 }), /не файл правил/);
  throws(() => M.planImport(d, null), /не файл правил/);
});

console.log(`\n${n - failed}/${n} ok`);
process.exit(failed ? 1 : 0);
