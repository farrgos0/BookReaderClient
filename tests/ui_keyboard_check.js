// Проверка: пока открыта экранная клавиатура, касание в любом месте только прячет её (телефон).
// Клавиатура имитируется: фокус в поле — видимая область ниже, фокус ушёл — сразу прежняя (как на телефоне).
// Запуск: из папки web поднять сервер (python -m http.server 8765), затем
//   node tests/ui_keyboard_check.js [ширина высота] [адрес]      (нужен Playwright: npm i playwright)
// По умолчанию 390×800 и http://127.0.0.1:8765/. Шаг 11.3 аудита интерфейса (SPEC-1.2.0).
const { chromium } = require('playwright');
(async () => {
  const W = +(process.argv[2] || 390), H = +(process.argv[3] || 800), KB = Math.round(H * 0.42);
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: W, height: H }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
  // «клавиатура»: фокус в текстовом поле — видимая область ниже на KB (окно прижато к верху и укорачивается),
  // фокус ушёл — сразу прежняя. Синхронно, как на телефоне: раскладка меняется до того, как палец отпущен.
  await p.addInitScript((KB) => {
    const st = document.createElement('style');
    st.textContent = 'html.kb #ask .modal-card, html.kb .prp-card { max-height: calc(100dvh - 32px - ' + KB + 'px) !important; } html.kb .prp-card { height: calc(100dvh - ' + KB + 'px) !important; }';
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(st));
    const text = (t) => t && t.matches && t.matches('input:not([type=checkbox]):not([type=radio]), textarea');
    document.addEventListener('focusin', (e) => { if (text(e.target)) document.documentElement.classList.add('kb'); });
    document.addEventListener('focusout', (e) => { if (text(e.target)) document.documentElement.classList.remove('kb'); });
  }, KB);
  await p.goto(process.argv[4] || 'http://127.0.0.1:8765/');
  await p.evaluate(() => localStorage.setItem('fb2r:pron', JSON.stringify({ v: 2, folders: [], rules: [{ id: '1', f: null, w: 'а', s: 'плюс', t: 1 }], opts: {} })));
  await p.reload(); await p.waitForTimeout(300);
  await p.evaluate(() => document.getElementById('btnPron').click()); await p.waitForTimeout(300);
  const kbOpen = () => p.evaluate(() => !!document.activeElement && document.activeElement.matches('input:not([type=checkbox]):not([type=radio])'));
  const tapAt = async (sel) => { const r = await p.locator(sel).boundingBox(); await p.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2); await p.waitForTimeout(400); };
  const state = () => p.evaluate(() => ({ open: !document.getElementById('ask').hidden,
    some: !!document.querySelector('#ask input[name=prsc][value=some]:checked'),
    c: !!document.querySelector('#ask .pr-case input:checked'), s: JSON.parse(localStorage.getItem('fb2r:pron')).rules[0].s }));
  const openRule = async () => { await p.locator('.prp-rule .prp-open').first().tap(); await p.waitForTimeout(200); await p.locator('.pr-s').tap(); await p.waitForTimeout(300); };
  const T = `${W}×${H}:`;

  // «Отмена» при открытой клавиатуре: первое касание только прячет клавиатуру, второе — закрывает
  await openRule();
  ok(await kbOpen(), `${T} клавиатура открыта`);
  await tapAt('.pr-cancel');
  let st = await state();
  ok(st.open && !st.some && !(await kbOpen()), `${T} касание «Отмены» при клавиатуре — только спрятало её, ничего не нажато`);
  await tapAt('.pr-cancel');
  ok(!(await state()).open, `${T} второе касание «Отмены» — окно закрыто`);

  // «Сохранить»: так же
  await openRule();
  await p.locator('.pr-s').fill('пл+юс'); await p.waitForTimeout(100);
  await tapAt('.pr-save');
  st = await state();
  ok(st.open && st.s === 'плюс' && !(await kbOpen()), `${T} касание «Сохранить» при клавиатуре — только спрятало её`);
  await tapAt('.pr-save');
  st = await state();
  ok(!st.open && st.s === 'пл+юс', `${T} второе касание «Сохранить» — сохранено`);

  // «Аа» и пустое место
  await openRule();
  await tapAt('.pr-case input');
  ok(!(await state()).c && !(await kbOpen()), `${T} «Аа» при клавиатуре — не переключён, клавиатура спрятана`);
  await tapAt('.pr-case input');
  ok((await state()).c, `${T} второе касание «Аа» — переключён`);
  // касание другого поля — курсор переходит в него, клавиатура остаётся
  await p.locator('.pr-s').tap(); await p.waitForTimeout(300);
  await tapAt('.pr-w');
  ok(await p.evaluate(() => document.activeElement.classList.contains('pr-w')), `${T} касание другого поля — курсор в нём`);
  await tapAt('#askHead');
  ok(!(await kbOpen()) && (await state()).open, `${T} касание заголовка — клавиатура спрятана, окно на месте`);
  await b.close();
})();
