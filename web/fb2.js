// Разбор FB2 и FB2.ZIP прямо в браузере.
// Результат: { title, authors, annotation, cover, items: [...], toc: [...] }
// item: { kind: 'title'|'subtitle'|'p'|'verse'|'empty'|'image'|'author', text, level, cls, src }

(function () {
  "use strict";

  // ---------- кодировка ----------
  function decodeXml(buf) {
    const head = new TextDecoder("latin1").decode(new Uint8Array(buf, 0, Math.min(400, buf.byteLength)));
    const m = head.match(/encoding\s*=\s*["']([\w\-]+)["']/i);
    let enc = m ? m[1].toLowerCase() : "utf-8";
    try {
      return new TextDecoder(enc).decode(buf);
    } catch (_) {
      return new TextDecoder("utf-8").decode(buf);
    }
  }

  // ---------- терпимый разбор: многие FB2 «в дикой природе» — не совсем правильный XML ----------
  const xmlOk = (d) => !d.getElementsByTagName("parsererror").length;
  const RENAME = ["image", "title", "body", "style", "table"]; // в HTML у этих тегов особое поведение
  function parseLenient(xml) {
    const P = new DOMParser();
    let doc = P.parseFromString(xml, "application/xml");
    if (xmlOk(doc)) return doc;
    // 1) типичные ошибки: голый «&», управляющие символы
    const fixed = xml.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
      .replace(/&(?!(?:[a-zA-Z][\w.-]*|#\d+|#x[\da-fA-F]+);)/g, "&amp;");
    doc = P.parseFromString(fixed, "application/xml");
    if (xmlOk(doc)) return doc;
    // 1б) абзацы вокруг строк и ячеек таблицы («<table><p><tr>…</td></p>») — частая ошибка конвертеров
    const fixedTables = fixed.replace(/<table\b[\s\S]*?<\/table>/gi, (t) => t.replace(/<\/?p\s*>/gi, ""));
    if (fixedTables !== fixed) {
      doc = P.parseFromString(fixedTables, "application/xml");
      if (xmlOk(doc)) return doc;
    }
    // 2) незакрытые теги, HTML-сущности (&nbsp;) — разбираем как HTML и переносим в XML-документ
    let html = fixedTables.replace(/<\?xml[^>]*>/i, "");
    RENAME.forEach((t) => { html = html.replace(new RegExp(`<(/?)${t}\\b`, "gi"), `<$1fb-${t}`); });
    const h = P.parseFromString(html, "text/html");
    const src = h.querySelector("fictionbook");
    if (!src) return null;
    const out = document.implementation.createDocument(null, "FictionBook", null);
    const copy = (from, to) => {
      from.childNodes.forEach((n) => {
        if (n.nodeType === 3) to.appendChild(out.createTextNode(n.nodeValue));
        else if (n.nodeType === 1) {
          const name = n.localName.replace(/^fb-/, "");
          let el;
          try { el = out.createElementNS(null, name); } catch (_) { return; }
          for (const a of n.attributes) { try { el.setAttribute(a.name, a.value); } catch (_) {} }
          copy(n, el);
          to.appendChild(el);
        }
      });
    };
    copy(src, out.documentElement);
    return out;
  }

  // ---------- XML-помощники ----------
  const kids = (el, name) => Array.from(el ? el.children : []).filter((c) => !name || c.localName === name);
  const kid = (el, name) => kids(el, name)[0] || null;

  function textOf(el) {
    // текст без сносок вида [1]
    let out = "";
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeType === 1) {
        const type = n.getAttribute("type");
        if (n.localName === "a" && type === "note") return;
        out += textOf(n);
      }
    });
    return out;
  }
  const norm = (s) => s.replace(/\s+/g, " ").trim();

  // ---------- разбор ----------
  async function parseFb2(buf, fileName) {
    const file = { name: fileName || "book.fb2" };
    const xml = decodeXml(buf).replace(/^﻿/, "");
    const doc = parseLenient(xml);
    if (!doc) throw new Error("Файл повреждён: это не FB2 или разметка испорчена так, что текст не восстановить");
    const root = doc.documentElement;
    if (root.localName !== "FictionBook") throw new Error("Файл не похож на FB2");

    // картинки
    const images = {};
    kids(root, "binary").forEach((b) => {
      const id = b.getAttribute("id");
      if (id) images[id] = `data:${b.getAttribute("content-type") || "image/jpeg"};base64,${b.textContent.replace(/\s+/g, "")}`;
    });
    const imgSrc = (el) => {
      const href = el.getAttribute("l:href") || el.getAttribute("xlink:href") ||
        Array.from(el.attributes).find((a) => a.localName === "href")?.value || "";
      return images[href.replace(/^#/, "")] || null;
    };

    // описание
    const ti = kid(kid(root, "description"), "title-info");
    const title = norm(ti && kid(ti, "book-title") ? kid(ti, "book-title").textContent : file.name.replace(/\.(fb2|zip)+$/i, ""));
    const authors = kids(ti, "author").map((a) =>
      ["first-name", "middle-name", "last-name"].map((t) => (kid(a, t) ? norm(kid(a, t).textContent) : "")).filter(Boolean).join(" ") ||
      (kid(a, "nickname") ? norm(kid(a, "nickname").textContent) : "")
    ).filter(Boolean);
    const ann = kid(ti, "annotation");
    const annotation = ann ? kids(ann, "p").map((p) => norm(textOf(p))).filter(Boolean) : [];
    const coverImg = kid(kid(ti, "coverpage"), "image");
    const cover = coverImg ? imgSrc(coverImg) : null;

    const items = [];
    const toc = [];
    const push = (kind, text, extra) => {
      text = norm(text || "");
      if (!text && kind !== "empty" && kind !== "image") return;
      items.push(Object.assign({ kind, text }, extra || {}));
    };

    function walkBlock(el, level, cls) {
      switch (el.localName) {
        case "title": {
          const t = kids(el, "p").map((p) => norm(textOf(p))).filter(Boolean).join(". ") || norm(textOf(el));
          if (!t) return;
          if (!cls) toc.push({ title: t, level, item: items.length });
          push("title", t, { level, cls });
          break;
        }
        case "subtitle": push("subtitle", textOf(el), { cls }); break;
        case "p": {
          // весь абзац жирный (<p><strong>Глава 1</strong></p>) — признак заголовка для поиска глав
          const k = el.children;
          const bold = k.length === 1 && k[0].localName === "strong" && norm(k[0].textContent) === norm(el.textContent);
          push("p", textOf(el), bold ? { cls, st: { b: true } } : { cls });
          break;
        }
        case "empty-line": push("empty", ""); break;
        case "text-author": push("author", textOf(el), { cls }); break;
        case "image": { const s = imgSrc(el); if (s) push("image", "", { src: s }); break; }
        case "epigraph": kids(el).forEach((c) => walkBlock(c, level, "epigraph")); break;
        case "cite": kids(el).forEach((c) => walkBlock(c, level, "cite")); break;
        case "annotation": kids(el).forEach((c) => walkBlock(c, level, "epigraph")); break;
        case "poem":
          kids(el).forEach((c) => {
            if (c.localName === "stanza") {
              kids(c).forEach((s) => {
                if (s.localName === "v") push("verse", textOf(s), { cls });
                else walkBlock(s, level + 1, "poem");
              });
              push("empty", "");
            } else if (c.localName === "title") walkBlock(c, level + 1, "poem");
            else walkBlock(c, level, cls);
          });
          break;
        case "table":
          el.querySelectorAll("tr").forEach((tr) =>
            push("p", Array.from(tr.children).map((td) => norm(textOf(td))).filter(Boolean).join(" | "), { cls: "table" }));
          break;
        case "section": walkSection(el, level + 1); break;
        default:
          if (el.children.length) kids(el).forEach((c) => walkBlock(c, level, cls));
          else push("p", textOf(el), { cls });
      }
    }
    function walkSection(sec, level) {
      kids(sec).forEach((c) => walkBlock(c, level, null));
    }

    kids(root, "body").forEach((body) => {
      if (/notes|comments/i.test(body.getAttribute("name") || "")) return;
      kids(body).forEach((c) => {
        if (c.localName === "section") walkSection(c, 1);
        else if (c.localName === "title") return; // название книги уже показано в шапке
        else walkBlock(c, 0, null);
      });
    });

    return { title, authors, annotation, cover, items, toc };
  }

  window.FB2 = { parse: parseFb2, decodeXml };
})();
