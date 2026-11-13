/* Свой выбор из списка вместо системного окна <select> (на Android оно выглядит чужим).
   Касание или клик по любому <select> открывает окно в стиле читалки: заголовок — подпись поля, пункты,
   у выбранного — отметка. Выбор меняет select.value и шлёт input/change, как обычный выбор, — код
   страниц ничего не знает о замене. Клавиатура (Tab, стрелки) работает со списком как обычно; Enter/пробел
   открывают это же окно. Закрыть — ✕, фон, Esc, «Назад» (Picker.close из app.js). */
(function () {
  "use strict";
  let box = null, cur = null, focusBack = null;

  function build() {
    box = document.createElement("div");
    box.className = "modal pick";
    box.hidden = true;
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.innerHTML = `<div class="modal-card"><div class="panel-head"><span class="pick-head"></span>
      <button class="icon-btn pick-x" title="Закрыть" aria-label="Закрыть">✕</button></div>
      <div class="pick-list" role="listbox"></div></div>`;
    document.body.appendChild(box);
    box.addEventListener("click", (e) => {
      if (e.target === box || e.target.closest(".pick-x")) return close();
      const it = e.target.closest(".pick-it");
      if (it && !it.disabled) choose(Number(it.dataset.i));
    });
    box.addEventListener("keydown", (e) => {
      const items = [...box.querySelectorAll(".pick-it:not(:disabled)")];
      const k = items.indexOf(document.activeElement);
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = items[Math.max(0, Math.min(items.length - 1, k + (e.key === "ArrowDown" ? 1 : -1)))];
        if (n) n.focus();
      }
    });
  }

  // подпись поля: <label><span>Голос</span><select> → «Голос»; иначе aria-label / title
  function labelOf(sel) {
    const lab = sel.closest("label");
    const span = lab && lab.querySelector("span");
    return (span && span.textContent.trim()) || sel.getAttribute("aria-label") || sel.title || "Выбор";
  }

  function open(sel) {
    if (!box) build();
    cur = sel;
    focusBack = sel;
    box.querySelector(".pick-head").textContent = labelOf(sel);
    const list = box.querySelector(".pick-list");
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    let html = "", group = null;
    [...sel.options].forEach((o, i) => {
      if (o.hidden) return;
      const g = o.parentElement.tagName === "OPTGROUP" ? o.parentElement : null;
      if (g !== group) { group = g; if (g) html += `<div class="pick-group">${esc(g.label)}</div>`; }
      const on = i === sel.selectedIndex;
      html += `<button class="pick-it${on ? " on" : ""}" data-i="${i}" role="option" aria-selected="${on}"${o.disabled ? " disabled" : ""}>
        <span>${esc(o.textContent)}</span><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    });
    list.innerHTML = html;
    box.hidden = false;
    const on = list.querySelector(".pick-it.on") || list.querySelector(".pick-it");
    if (on) {
      on.scrollIntoView({ block: "center" });
      // фокус на выбранном — для клавиатуры (ПК); на телефоне не нужен: была бы рамка
      if (matchMedia("(hover: hover)").matches) { try { on.focus({ preventScroll: true }); } catch (_) {} }
    }
  }

  function choose(i) {
    const sel = cur;
    close(false);
    if (!sel || sel.selectedIndex === i) return;
    sel.selectedIndex = i;
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function close(refocus) {
    if (!box || box.hidden) return false;
    box.hidden = true;
    cur = null;
    // мышь/клавиатура (ПК) — фокус обратно на список; на телефоне фокус не нужен (рамка «зажатой» кнопки)
    if (refocus !== false && focusBack && matchMedia("(hover: hover)").matches) { try { focusBack.focus({ preventScroll: true }); } catch (_) {} }
    focusBack = null;
    return true;
  }

  const target = (e) => {
    const s = e.target && e.target.closest ? e.target.closest("select") : null;
    return s && !s.disabled && !s.multiple && s.size <= 1 ? s : null;
  };

  // касание: системное окно откроется на событиях мыши после касания — их отменяем (preventDefault у touchend)
  let touch = null;
  window.addEventListener("touchstart", (e) => {
    const s = target(e);
    touch = s && e.touches.length === 1 ? { s, x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { capture: true, passive: true });
  window.addEventListener("touchmove", (e) => {
    if (touch && Math.hypot(e.touches[0].clientX - touch.x, e.touches[0].clientY - touch.y) > 10) touch = null;
  }, { capture: true, passive: true });
  window.addEventListener("touchend", (e) => {
    if (e.defaultPrevented) { touch = null; return; }   // касание уже занято (например, прячет клавиатуру)
    const t = touch;
    touch = null;
    if (!t || target(e) !== t.s) return;
    e.preventDefault();
    open(t.s);
  }, { capture: true, passive: false });
  // мышь (и мышиные события, если касание пришло без touch-событий)
  window.addEventListener("mousedown", (e) => {
    const s = target(e);
    if (!s || e.button !== 0) return;
    e.preventDefault();
    try { s.focus({ preventScroll: true }); } catch (_) {}
    open(s);
  }, true);
  // клавиатура: Enter, пробел, F4, Alt+↓ — наше окно; стрелки без Alt меняют значение как обычно
  window.addEventListener("keydown", (e) => {
    const s = target(e);
    if (!s || (box && !box.hidden)) return;
    if (e.key === "Enter" || e.key === " " || e.key === "F4" || (e.altKey && e.key === "ArrowDown")) {
      e.preventDefault();
      e.stopPropagation();
      open(s);
    }
  }, true);

  window.Picker = { open, close: () => close(), isOpen: () => !!box && !box.hidden };
})();
