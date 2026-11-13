/* Долгое нажатие пальцем на элемент списка (как в Telegram): включает выбор нескольких.
   longPress(container, itemSelector, onLong(item), ignore) — только касание и перо (мышью — обычный клик);
   после срабатывания следующий клик по элементу гасится, системное меню (долгое касание в WebView) не открывается. */
(function () {
  "use strict";
  const DELAY = 480, SLOP = 10;
  function longPress(container, selector, onLong, ignore) {
    const skip = "input, textarea, select, [contenteditable]" + (ignore ? ", " + ignore : "");
    let timer = 0, start = null, fired = false;
    const cancel = () => { clearTimeout(timer); timer = 0; start = null; };
    container.addEventListener("pointerdown", (e) => {
      fired = false;
      if (e.pointerType === "mouse" || !e.isPrimary || e.defaultPrevented) return;   // касание, прячущее клавиатуру, — не в счёт
      const item = e.target.closest(selector);
      if (!item || !container.contains(item) || e.target.closest(skip)) return;
      start = { x: e.clientX, y: e.clientY, item };
      timer = setTimeout(() => {
        const it = start && start.item;
        cancel();
        if (!it || !it.isConnected) return;
        fired = true;
        try { if (navigator.vibrate) navigator.vibrate(15); } catch (_) {}
        onLong(it);
      }, DELAY);
    });
    container.addEventListener("pointermove", (e) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) cancel();
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((t) => container.addEventListener(t, () => { if (timer) cancel(); }));
    container.addEventListener("scroll", cancel, true);
    // клик, пришедший после долгого нажатия, — не открывать элемент
    container.addEventListener("click", (e) => {
      if (!fired) return;
      fired = false;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    container.addEventListener("contextmenu", (e) => { if (e.target.closest(selector)) e.preventDefault(); });
  }
  window.longPress = longPress;
})();
