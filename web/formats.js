// Разбор книг разных форматов в общую структуру:
// { title, authors, annotation, cover, items, toc, format }
// item: { kind: 'title'|'subtitle'|'p'|'verse'|'empty'|'image'|'author', text, level, cls, src }
// toc:  { title, level, item }  — item: индекс в items
(function () {
  "use strict";

  const norm = (s) => String(s || "").replace(/[\s ]+/g, " ").trim();
  const extOf = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [, ""])[1];
  const baseName = (name) => String(name).replace(/\.(fb2\.zip|[a-z0-9]+)$/i, "");

  function titleFromFileName(name) {
    const b = baseName(name).replace(/[_]+/g, " ").trim();
    const m = b.match(/^(.+?)\s+[-–—]\s+(.+)$/); // «Автор - Название»
    return m ? { title: m[2].trim(), authors: [m[1].trim()] } : { title: b, authors: [] };
  }

  // ---------- текст и кодировки ----------
  function decodeText(bytes, hint) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder("utf-8").decode(u8.subarray(3));
    if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder("utf-16le").decode(u8.subarray(2));
    if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder("utf-16be").decode(u8.subarray(2));
    if (hint) { try { return new TextDecoder(hint).decode(u8); } catch (_) {} }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(u8); } catch (_) {}
    return new TextDecoder("windows-1251").decode(u8);
  }

  function sniffCharset(u8) {
    const head = new TextDecoder("latin1").decode(u8.subarray(0, Math.min(2048, u8.length)));
    const m = head.match(/charset\s*=\s*["']?([\w-]+)/i) || head.match(/encoding\s*=\s*["']([\w-]+)/i);
    return m ? m[1].toLowerCase() : null;
  }

  function parseXml(str) {
    let doc = new DOMParser().parseFromString(str, "application/xhtml+xml");
    if (doc.getElementsByTagName("parsererror").length) doc = new DOMParser().parseFromString(str, "text/html");
    return doc;
  }

  function sniffImage(u8) {
    if (u8[0] === 0xff && u8[1] === 0xd8) return "image/jpeg";
    if (u8[0] === 0x89 && u8[1] === 0x50) return "image/png";
    if (u8[0] === 0x47 && u8[1] === 0x49) return "image/gif";
    if (u8[0] === 0x42 && u8[1] === 0x4d) return "image/bmp";
    if (u8[0] === 0x52 && u8[1] === 0x49 && u8[8] === 0x57) return "image/webp";
    const head = new TextDecoder("latin1").decode(u8.subarray(0, 200));
    if (/<svg/i.test(head)) return "image/svg+xml";
    return null;
  }
  const blobUrl = (u8, type) => URL.createObjectURL(new Blob([u8], { type: type || sniffImage(u8) || "application/octet-stream" }));

  // ---------- оформление абзаца (для поиска глав по шрифту) ----------
  // У абзаца может быть st: { fs, b } — размер шрифта основной части текста (в условных единицах, сравнивается
  // только внутри одной книги) и «весь абзац жирный». Нужен только поиску глав (findChapters), на показ не влияет.
  class StyleAcc {
    constructor() { this.m = new Map(); this.tot = 0; this.bold = 0; }
    add(fs, b, n) {
      if (!(n > 0)) return;
      const k = fs > 0 ? Math.round(fs * 100) / 100 : 0;
      this.m.set(k, (this.m.get(k) || 0) + n);
      this.tot += n; if (b) this.bold += n;
    }
    get() {
      if (!this.tot) return undefined;
      let fs = 0, best = -1;
      for (const [k, n] of this.m) if (n > best) { best = n; fs = k; }
      const b = this.bold / this.tot >= 0.9;
      return fs || b ? { fs: fs || undefined, b } : undefined;
    }
  }
  const withSt = (extra, st) => (st ? Object.assign(extra || {}, { st }) : extra);

  // CSS — только то, что нужно для размера и жирности: правила вида tag, .class, tag.class
  const FONT_KW = { "xx-small": 0.6, "x-small": 0.75, small: 0.89, medium: 1, large: 1.2, "x-large": 1.5, "xx-large": 2, "xxx-large": 3, smaller: 0.83, larger: 1.2 };
  // размер: { abs } — в «em при 12pt = 1» или { rel } — множитель к родителю
  function cssSize(v) {
    v = String(v || "").trim().toLowerCase();
    if (FONT_KW[v]) return /er$/.test(v) ? { rel: FONT_KW[v] } : { abs: FONT_KW[v] };
    const m = v.match(/^([\d.]+)\s*(px|pt|em|rem|%|ex)?$/);
    if (!m) return null;
    const x = Number(m[1]);
    if (!(x > 0)) return null;
    switch (m[2]) {
      case "px": return { abs: x / 16 };
      case "pt": return { abs: x / 12 };
      case "rem": return { abs: x };
      case "%": return { rel: x / 100 };
      case "ex": return { rel: x / 2 };
      default: return { rel: x };   // em или без единиц
    }
  }
  const cssBold = (v) => /bold|bolder|[6-9]00/.test(String(v || "").toLowerCase());
  function cssDecls(text) {
    const out = {};
    for (const d of String(text || "").split(";")) {
      const k = d.indexOf(":");
      if (k < 0) continue;
      const prop = d.slice(0, k).trim().toLowerCase(), val = d.slice(k + 1).replace(/!important/i, "").trim();
      if (prop === "font-size") { const z = cssSize(val); if (z) out.size = z; }
      else if (prop === "font-weight") out.bold = cssBold(val);
      else if (prop === "font") {
        out.bold = cssBold(val) || undefined;
        const z = val.split(/\s+/).map((w) => cssSize(w.split("/")[0])).find(Boolean);
        if (z) out.size = z;
      }
    }
    return out;
  }
  function parseCss(text, into) {
    const map = into || new Map();
    const src = String(text || "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]*\{([\s\S]*?\})\s*\}/g, "$1");
    const re = /([^{}@]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(src))) {
      const d = cssDecls(m[2]);
      if (d.size === undefined && d.bold === undefined) continue;
      for (let sel of m[1].split(",")) {
        sel = sel.trim().toLowerCase();
        if (!/^([a-z][a-z0-9]*)?(\.[\w-]+)?$/.test(sel) || !sel) continue;
        map.set(sel, Object.assign(map.get(sel) || {}, d));
      }
    }
    return map;
  }
  const TAG_STYLE = { b: { bold: true }, strong: { bold: true }, big: { size: { rel: 1.2 } }, small: { size: { rel: 0.85 } } };
  const FONT_TAG = { 1: 0.6, 2: 0.8, 3: 1, 4: 1.15, 5: 1.5, 6: 2, 7: 3 };
  // собственное оформление элемента: теги, правила CSS (tag < .class < tag.class), атрибут style
  function ownStyle(el, css) {
    const tag = el.localName.toLowerCase();
    const r = Object.assign({}, TAG_STYLE[tag]);
    if (tag === "font" && el.getAttribute("size")) {
      const v = el.getAttribute("size"), n = Number(v);
      if (/^[+-]/.test(v)) r.size = { rel: 1 + n * 0.2 }; else if (FONT_TAG[n]) r.size = { abs: FONT_TAG[n] };
    }
    if (css && css.size) {
      const cls = (el.getAttribute("class") || "").toLowerCase().split(/\s+/).filter(Boolean);
      for (const key of [tag, ...cls.map((c) => "." + c), ...cls.map((c) => tag + "." + c)]) if (css.has(key)) Object.assign(r, css.get(key));
    }
    const inl = el.getAttribute("style");
    if (inl) Object.assign(r, cssDecls(inl));
    return r;
  }
  // оформление блока: от корня документа вниз; если весь текст блока — в одном строчном элементе (b, span…), учитываем и его
  function blockStyle(el, css) {
    const chain = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) chain.unshift(n);
    let fs = 1, bold = false;
    const apply = (n) => {
      const st = ownStyle(n, css);
      if (st.size) fs = st.size.abs !== undefined ? st.size.abs : fs * st.size.rel;
      if (st.bold !== undefined) bold = !!st.bold;
    };
    chain.forEach(apply);
    const full = norm(el.textContent);
    let n = el;
    for (let depth = 0; depth < 4; depth++) {
      const kids = Array.from(n.children);
      if (kids.length !== 1 || norm(kids[0].textContent) !== full) break;
      n = kids[0]; apply(n);
    }
    return fs !== 1 || bold ? { fs: Math.round(fs * 100) / 100, b: bold } : undefined;
  }

  // ---------- общий разбор HTML/XHTML ----------
  const BLOCK = new Set(["p", "div", "section", "article", "blockquote", "li", "dd", "dt", "pre", "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tfoot", "tr", "td", "th", "figure", "figcaption", "ul", "ol", "dl", "header", "footer", "aside",
    "main", "center", "body", "hr", "address", "caption", "nav", "poem", "stanza", "mbp:pagebreak"]);
  const SKIP = new Set(["script", "style", "head", "title", "noscript", "template", "svg:title"]);

  class HtmlCollector {
    constructor(imageResolver) {
      this.items = [];
      this.headings = [];
      this.ids = new Map();
      this.resolveImage = imageResolver; // (src, base) → Promise<url>|null
      this.pendingImages = [];
    }
    push(kind, text, extra) {
      text = norm(text);
      if (!text && kind !== "empty" && kind !== "image") return;
      if (kind === "empty" && (!this.items.length || this.items[this.items.length - 1].kind === "empty")) return;
      this.items.push(Object.assign({ kind, text }, extra || {}));
    }
    isNoteRef(el) {
      const t = (el.getAttribute("epub:type") || el.getAttribute("role") || "").toLowerCase();
      if (/noteref|doc-noteref/.test(t)) return true;
      if (el.localName === "sup" || el.localName === "a") {
        const s = el.textContent.trim();
        if (/^[\[(]?\d{1,3}[\])]?$|^\*+$/.test(s) && (el.localName === "sup" || /^#|filepos|note/i.test(el.getAttribute("href") || el.getAttribute("filepos") || ""))) return true;
      }
      return false;
    }
    inlineText(node, out) {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) out.push(this.pre ? n.nodeValue : n.nodeValue.replace(/[\r\n]+/g, " "));
        else if (n.nodeType === 1) {
          const tag = n.localName.toLowerCase();
          if (SKIP.has(tag) || this.isNoteRef(n)) continue;
          if (tag === "br") out.push("\n");
          else if (tag === "img" || tag === "image") this.image(n);
          else this.inlineText(n, out);
        }
      }
      return out;
    }
    image(el) {
      const src = el.getAttribute("src") || el.getAttribute("href") || el.getAttribute("xlink:href") ||
        el.getAttribute("recindex") && "recindex:" + el.getAttribute("recindex") || "";
      if (!src || !this.resolveImage) return;
      const item = { kind: "image", text: "", src: "" };
      this.items.push(item);
      this.pendingImages.push(Promise.resolve(this.resolveImage(src, this.base)).then((u) => { item.src = u || ""; }).catch(() => {}));
    }
    hasBlockChild(el) {
      for (const c of el.children) if (BLOCK.has(c.localName.toLowerCase()) || this.hasBlockChild(c)) return true;
      return false;
    }
    emitParagraph(text, cls, el) {
      const lines = text.split("\n").map(norm).filter(Boolean);
      if (lines.length > 1 && lines.every((l) => l.length < 70)) lines.forEach((l) => this.push("verse", l, { cls }));
      else this.push("p", lines.join(" "), withSt({ cls }, el ? blockStyle(el, this.css) : undefined));
    }
    walk(el, cls) {
      const tag = el.localName.toLowerCase();
      if (SKIP.has(tag) || this.isNoteRef(el)) return;
      const id = el.getAttribute && el.getAttribute("id");
      if (id) this.ids.set(this.base + "#" + id, this.items.length);
      const type = (el.getAttribute("epub:type") || "").toLowerCase();
      if (/footnote|endnote|rearnote|toc|landmarks|page-list/.test(type) && tag !== "body") return;

      const h = tag.match(/^h([1-6])$/);
      if (h) {
        const text = norm(this.inlineText(el, []).join(" "));
        if (text) {
          this.headings.push({ title: text, level: Number(h[1]), item: this.items.length });
          this.push("title", text, { level: Number(h[1]) });
        }
        return;
      }
      if (tag === "img" || tag === "image") return this.image(el);
      if (tag === "hr" || tag === "mbp:pagebreak") return this.push("empty", "");
      if (tag === "blockquote") cls = "cite";
      if (tag === "table") {
        el.querySelectorAll("tr").forEach((tr) =>
          this.push("p", Array.from(tr.children).map((c) => norm(c.textContent)).filter(Boolean).join(" | "), { cls: "table" }));
        return;
      }
      if (tag === "svg") { el.querySelectorAll("image").forEach((i) => this.image(i)); return; }

      if (!this.hasBlockChild(el)) {
        this.pre = tag === "pre";
        this.emitParagraph(this.inlineText(el, []).join(""), cls, el);
        this.pre = false;
        return;
      }
      // смешанное содержимое: строчные куски между блоками — отдельные абзацы
      let run = [];
      const flush = () => { if (run.length) { this.emitParagraph(run.join(""), cls); run = []; } };
      for (const n of el.childNodes) {
        if (n.nodeType === 3) run.push(n.nodeValue.replace(/[\r\n]+/g, " "));
        else if (n.nodeType === 1) {
          const t = n.localName.toLowerCase();
          if (BLOCK.has(t) || this.hasBlockChild(n) || /^h[1-6]$/.test(t)) { flush(); this.walk(n, cls); }
          else if (t === "br") run.push("\n");
          else if (t === "img" || t === "image") { flush(); this.image(n); }
          else if (!SKIP.has(t) && !this.isNoteRef(n)) run.push(this.inlineText(n, []).join(""));
        }
      }
      flush();
    }
    add(doc, base, css) {
      this.base = base || "";
      // стили документа: <style> внутри + переданные (связанные CSS-файлы EPUB)
      this.css = new Map(css || []);
      for (const st of Array.from(doc.getElementsByTagName("style"))) parseCss(st.textContent, this.css);
      this.ids.set(this.base, this.items.length);
      const body = doc.body || doc.getElementsByTagName("body")[0] || doc.documentElement;
      this.walk(body, null);
    }
    async done() { await Promise.all(this.pendingImages); this.items = this.items.filter((i) => i.kind !== "image" || i.src); }
  }

  // ---------- TXT / Markdown ----------
  const HEADING_RE = /^(глава|часть|книга|том|пролог|эпилог|предисловие|послесловие|вступление|заключение|интерлюдия|chapter|part|prologue|epilogue|book|interlude)(?=[\s.,:;!—-]|$)/i;

  function isHeadingLine(line) {
    if (line.length > 80) return false;
    if (HEADING_RE.test(line)) return true;
    if (/^([IVXLC]+|\d{1,3})\.?$/.test(line)) return true;
    if (/^\*{3}$|^\* \* \*$/.test(line)) return false;
    const letters = line.replace(/[^A-Za-zА-Яа-яЁё]/g, "");
    return letters.length >= 3 && letters === letters.toUpperCase() && line.length < 60 && !/[.,;]$/.test(line);
  }

  function parseTxt(bytes, name, markdown) {
    let text = decodeText(bytes).replace(/\r\n?/g, "\n");
    const front = {};
    if (markdown) {
      const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
      if (fm) {
        fm[1].split("\n").forEach((l) => { const m = l.match(/^(\w+):\s*["']?(.*?)["']?\s*$/); if (m) front[m[1].toLowerCase()] = m[2]; });
        text = text.slice(fm[0].length);
      }
    }
    const lines = text.split("\n");
    const blank = lines.filter((l) => !l.trim()).length;
    const byBlank = blank > lines.length * 0.08;
    const items = [], toc = [];
    const addPara = (t) => {
      t = norm(t);
      if (!t) return;
      if (markdown) {
        const h = t.match(/^(#{1,6})\s+(.*)$/);
        if (h) { toc.push({ title: h[2], level: h[1].length, item: items.length }); items.push({ kind: "title", text: h[2], level: h[1].length }); return; }
        t = t.replace(/[*_`]+/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^[-+>]\s+/, "");
      }
      if (/^(\*\s*){3}$|^-{3,}$/.test(t)) { items.push({ kind: "empty", text: "" }); return; }
      if (!markdown && isHeadingLine(t)) { toc.push({ title: t, level: 1, item: items.length }); items.push({ kind: "title", text: t, level: 1 }); return; }
      items.push({ kind: "p", text: t });
    };
    if (byBlank) {
      let buf = [];
      for (const l of lines) {
        if (!l.trim()) { addPara(buf.join(" ")); buf = []; }
        else if (markdown && /^#{1,6}\s/.test(l.trim())) { addPara(buf.join(" ")); buf = []; addPara(l); }
        else buf.push(l);
      }
      addPara(buf.join(" "));
    } else lines.forEach(addPara);
    const meta = titleFromFileName(name);
    if (front.title) meta.title = front.title;
    if (front.author) meta.authors = [front.author];
    return { ...meta, annotation: [], cover: null, items, toc };
  }

  // ---------- HTML ----------
  async function parseHtml(bytes, name) {
    const str = decodeText(bytes, sniffCharset(bytes));
    const doc = new DOMParser().parseFromString(str, "text/html");
    const c = new HtmlCollector((src) => (/^data:|^https?:/.test(src) ? src : null));
    c.add(doc, "");
    await c.done();
    const meta = titleFromFileName(name);
    const title = norm(doc.title) || meta.title;
    const author = doc.querySelector('meta[name="author"]');
    return { title, authors: author ? [norm(author.content)] : meta.authors, annotation: [], cover: null, items: c.items, toc: c.headings };
  }

  // ---------- EPUB ----------
  async function parseEpub(zip, name) {
    const container = parseXml(await zip.text("META-INF/container.xml") || "");
    const rootfile = container.getElementsByTagNameNS("*", "rootfile")[0];
    const opfPath = rootfile ? rootfile.getAttribute("full-path") : zip.names.find((n) => /\.opf$/i.test(n));
    if (!opfPath) throw new Error("В EPUB нет описания книги (OPF)");
    const opf = parseXml(await zip.text(opfPath));
    const q = (tag) => Array.from(opf.getElementsByTagNameNS("*", tag));

    const manifest = new Map();
    q("item").forEach((it) => manifest.set(it.getAttribute("id"), {
      href: Zip.resolve(opfPath, it.getAttribute("href") || ""), type: it.getAttribute("media-type") || "",
      props: it.getAttribute("properties") || "",
    }));
    const title = norm((q("title")[0] || {}).textContent) || titleFromFileName(name).title;
    const authors = q("creator").map((c) => norm(c.textContent)).filter(Boolean);
    const descEl = q("description")[0];
    const annotation = descEl ? [norm(new DOMParser().parseFromString(descEl.textContent, "text/html").body.textContent)].filter(Boolean) : [];

    const imgCache = new Map();
    const loadImage = async (path, type) => {
      if (!imgCache.has(path)) imgCache.set(path, zip.bytes(path).then((b) => (b ? blobUrl(b, type) : null)));
      return imgCache.get(path);
    };

    // обложка
    let coverPath = null;
    const coverMeta = q("meta").find((m) => m.getAttribute("name") === "cover");
    if (coverMeta && manifest.get(coverMeta.getAttribute("content"))) coverPath = manifest.get(coverMeta.getAttribute("content")).href;
    if (!coverPath) for (const m of manifest.values()) if (/cover-image/.test(m.props)) coverPath = m.href;
    if (!coverPath) for (const [id, m] of manifest) if (/^image\//.test(m.type) && /cover/i.test(id + m.href)) { coverPath = m.href; break; }
    const cover = coverPath ? await loadImage(coverPath) : null;

    const c = new HtmlCollector((src, base) => {
      if (/^data:/.test(src)) return src;
      const p = Zip.resolve(base, src);
      return loadImage(p);
    });
    const spine = q("itemref").map((r) => manifest.get(r.getAttribute("idref"))).filter((m) => m && /html|xml/.test(m.type));
    const cssCache = new Map();
    for (const m of spine) {
      const text = await zip.text(m.href);
      if (!text) continue;
      const doc = parseXml(text);
      const body = doc.body || doc.getElementsByTagName("body")[0];
      // связанные таблицы стилей (размер шрифта и жирность заголовков — для поиска глав)
      let css = null;
      for (const ln of Array.from(doc.getElementsByTagName("link"))) {
        if (!/stylesheet/i.test(ln.getAttribute("rel") || "") || !ln.getAttribute("href")) continue;
        const path = Zip.resolve(m.href, ln.getAttribute("href"));
        if (!cssCache.has(path)) cssCache.set(path, parseCss(await zip.text(path) || ""));
        css = css || new Map();
        for (const [k, v] of cssCache.get(path)) css.set(k, Object.assign(css.get(k) || {}, v));
      }
      // страница-обложка (только картинка) — пропускаем, обложка и так в шапке
      if (body && !norm(body.textContent) && body.querySelectorAll("img, image").length === 1 && cover && spine.indexOf(m) < 2) continue;
      c.add(doc, m.href, css);
    }
    await c.done();

    // оглавление: EPUB3 nav или EPUB2 NCX
    let toc = [];
    const findItem = (href) => {
      const [file, frag] = href.split("#");
      if (frag && c.ids.has(file + "#" + frag)) return c.ids.get(file + "#" + frag);
      return c.ids.has(file) ? c.ids.get(file) : null;
    };
    const navItem = [...manifest.values()].find((m) => /\bnav\b/.test(m.props));
    if (navItem) {
      const nav = parseXml(await zip.text(navItem.href) || "");
      const tocNav = Array.from(nav.getElementsByTagName("nav")).find((n) => /toc/.test(n.getAttribute("epub:type") || "")) || nav.getElementsByTagName("nav")[0];
      const walk = (ol, level) => {
        if (!ol) return;
        for (const li of ol.children) {
          if (li.localName !== "li") continue;
          const a = li.querySelector(":scope > a, :scope > span");
          if (a && a.getAttribute("href")) {
            const idx = findItem(Zip.resolve(navItem.href, a.getAttribute("href")) + (a.getAttribute("href").includes("#") ? "#" + a.getAttribute("href").split("#")[1] : ""));
            if (idx !== null) toc.push({ title: norm(a.textContent), level, item: idx });
          }
          walk(li.querySelector(":scope > ol"), level + 1);
        }
      };
      if (tocNav) walk(tocNav.querySelector("ol"), 1);
    }
    if (!toc.length) {
      const ncxId = (q("spine")[0] || { getAttribute: () => null }).getAttribute("toc");
      const ncx = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((m) => /ncx/.test(m.type));
      if (ncx) {
        const doc = parseXml(await zip.text(ncx.href) || "");
        const walk = (parent, level) => {
          for (const np of parent.children) {
            if (np.localName !== "navPoint") continue;
            const label = np.getElementsByTagNameNS("*", "text")[0];
            const content = np.getElementsByTagNameNS("*", "content")[0];
            if (label && content) {
              const src = content.getAttribute("src");
              const idx = findItem(Zip.resolve(ncx.href, src) + (src.includes("#") ? "#" + src.split("#")[1] : ""));
              if (idx !== null) toc.push({ title: norm(label.textContent), level, item: idx });
            }
            walk(np, level + 1);
          }
        };
        const map = doc.getElementsByTagNameNS("*", "navMap")[0];
        if (map) walk(map, 1);
      }
    }
    if (!toc.length) toc = c.headings;
    return { title, authors, annotation, cover, items: c.items, toc };
  }

  // ---------- DOCX ----------
  async function parseDocx(zip, name) {
    const doc = parseXml(await zip.text("word/document.xml"));
    const W = (el, tag) => Array.from(el.getElementsByTagNameNS("*", tag));
    const styles = new Map();
    const stylesXml = await zip.text("word/styles.xml");
    // размер (w:sz — в полупунктах) и жирность: прямо у фрагмента текста → у стиля (и его родителя) → по умолчанию
    const rProps = (rPr) => {
      if (!rPr) return {};
      const sz = W(rPr, "sz")[0], b = W(rPr, "b")[0];
      return {
        sz: sz ? Number(sz.getAttribute("w:val")) / 2 : undefined,
        b: b ? !/^(0|false|off)$/i.test(b.getAttribute("w:val") || "") : undefined,
      };
    };
    let defaultSz = 11;
    if (stylesXml) {
      const sx = parseXml(stylesXml);
      const dd = W(sx, "rPrDefault")[0];
      if (dd) { const d = rProps(W(dd, "rPr")[0]); if (d.sz) defaultSz = d.sz; }
      W(sx, "style").forEach((s) => {
        const nameEl = W(s, "name")[0];
        const lvl = W(s, "outlineLvl")[0];
        const based = W(s, "basedOn")[0];
        const rp = Array.from(s.children).find((c) => c.localName === "rPr");
        styles.set(s.getAttribute("w:styleId"), {
          name: (nameEl && nameEl.getAttribute("w:val") || "").toLowerCase(),
          level: lvl ? Number(lvl.getAttribute("w:val")) + 1 : null,
          based: based ? based.getAttribute("w:val") : null,
          r: rProps(rp),
        });
      });
    }
    const styleR = (id, key) => {
      for (let k = 0, st = styles.get(id); st && k < 6; k++, st = styles.get(st.based)) if (st.r[key] !== undefined) return st.r[key];
      return undefined;
    };
    const rels = new Map();
    const relXml = await zip.text("word/_rels/document.xml.rels");
    if (relXml) W(parseXml(relXml), "Relationship").forEach((r) => rels.set(r.getAttribute("Id"), Zip.resolve("word/document.xml", r.getAttribute("Target"))));

    const items = [], toc = [], pending = [];
    for (const p of W(doc, "p")) {
      let parent = p.parentNode, skip = false;
      while (parent && parent.nodeType === 1) { if (parent.localName === "Fallback") { skip = true; break; } parent = parent.parentNode; }
      if (skip) continue; // дубли из mc:Fallback
      let text = "";
      const psEl = W(p, "pStyle")[0], pStyleId = psEl ? psEl.getAttribute("w:val") : null;
      const acc = new StyleAcc();
      let run = { sz: styleR(pStyleId, "sz") || defaultSz, b: !!styleR(pStyleId, "b") };
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (c.nodeType !== 1) continue;
          const t = c.localName;
          if (t === "r") {
            const outer = run, rp = Array.from(c.children).find((x) => x.localName === "rPr");
            const own = rProps(rp), rs = rp && W(rp, "rStyle")[0], rsId = rs ? rs.getAttribute("w:val") : null;
            run = {
              sz: own.sz || (rsId && styleR(rsId, "sz")) || outer.sz,
              b: own.b !== undefined ? own.b : (rsId && styleR(rsId, "b") !== undefined ? styleR(rsId, "b") : outer.b),
            };
            walk(c);
            run = outer;
            continue;
          }
          if (t === "t") { text += c.textContent; acc.add(run.sz, run.b, c.textContent.replace(/\s+/g, "").length); }
          else if (t === "tab") text += " ";
          else if (t === "br" || t === "cr") text += " ";
          else if (t === "footnoteReference" || t === "endnoteReference" || t === "instrText" || t === "delText") continue;
          else if (t === "blip") {
            const id = c.getAttribute("r:embed");
            if (id && rels.has(id)) {
              const item = { kind: "image", text: "", src: "" };
              items.push(item);
              pending.push(zip.bytes(rels.get(id)).then((b) => { if (b) item.src = blobUrl(b); }));
            }
          } else if (t !== "pPr" && t !== "rPr") walk(c);
        }
      };
      walk(p);
      text = norm(text);
      if (!text) continue;
      const ps = W(p, "pStyle")[0];
      const st = ps ? styles.get(ps.getAttribute("w:val")) || { name: ps.getAttribute("w:val").toLowerCase() } : null;
      const outline = W(p, "outlineLvl")[0];
      let level = outline ? Number(outline.getAttribute("w:val")) + 1 : null;
      if (!level && st) {
        const m = st.name.match(/(heading|заголовок)\s*(\d)/);
        level = st.level || (m ? Number(m[2]) : st.name === "title" ? 1 : null);
      }
      if (level && level <= 6 && text.length < 200) {
        toc.push({ title: text, level, item: items.length });
        items.push({ kind: "title", text, level });
      } else items.push(withSt({ kind: "p", text }, acc.get()));
    }
    await Promise.all(pending);
    const coreXml = await zip.text("docProps/core.xml");
    const core = coreXml ? parseXml(coreXml) : null;
    const meta = titleFromFileName(name);
    const title = core && norm((core.getElementsByTagNameNS("*", "title")[0] || {}).textContent) || meta.title;
    const creator = core && norm((core.getElementsByTagNameNS("*", "creator")[0] || {}).textContent);
    return { title, authors: creator ? [creator] : meta.authors, annotation: [], cover: null, items: items.filter((i) => i.kind !== "image" || i.src), toc };
  }

  // ---------- ODT ----------
  async function parseOdt(zip, name) {
    const doc = parseXml(await zip.text("content.xml"));
    const items = [], toc = [], pending = [];
    // стили: размер (fo:font-size — pt или %) и жирность, с наследованием через parent-style-name
    const ost = new Map();
    const readStyles = (d) => {
      if (!d) return;
      for (const st of Array.from(d.getElementsByTagNameNS("*", "style"))) {
        if (st.localName !== "style") continue;
        const tp = Array.from(st.children).find((c) => c.localName === "text-properties");
        const fsAttr = tp && (tp.getAttribute("fo:font-size") || "");
        ost.set(st.getAttribute("style:name"), {
          parent: st.getAttribute("style:parent-style-name"),
          size: fsAttr ? (/%$/.test(fsAttr) ? { rel: parseFloat(fsAttr) / 100 } : cssSize(fsAttr)) : null,
          bold: tp && tp.getAttribute("fo:font-weight") ? cssBold(tp.getAttribute("fo:font-weight")) : undefined,
        });
      }
    };
    readStyles(parseXml(await zip.text("styles.xml") || "<x/>"));
    readStyles(doc);
    const resolve = (name, base) => {
      const chain = [];
      for (let k = 0, st = ost.get(name); st && k < 8; k++, st = ost.get(st.parent)) chain.unshift(st);
      let fs = base.fs, b = base.b;
      for (const st of chain) {
        if (st.size) fs = st.size.abs !== undefined ? st.size.abs : fs * st.size.rel;
        if (st.bold !== undefined) b = st.bold;
      }
      return { fs, b };
    };
    let acc = null, ctx = { fs: 1, b: false };
    const textOf = (n) => {
      let s = "";
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { s += c.nodeValue; if (acc) acc.add(ctx.fs, ctx.b, c.nodeValue.replace(/\s+/g, "").length); }
        else if (c.nodeType === 1) {
          const t = c.localName;
          if (t === "s") s += " ".repeat(Number(c.getAttribute("text:c") || 1));
          else if (t === "tab" || t === "line-break") s += " ";
          else if (t === "note" || t === "annotation" || t === "bookmark-ref") continue;
          else if (t === "frame") walkImages(c);
          else if (t === "span" && c.getAttribute("text:style-name")) {
            const outer = ctx; ctx = resolve(c.getAttribute("text:style-name"), ctx); s += textOf(c); ctx = outer;
          } else s += textOf(c);
        }
      }
      return s;
    };
    const walkImages = (n) => {
      Array.from(n.getElementsByTagNameNS("*", "image")).forEach((img) => {
        const href = img.getAttribute("xlink:href");
        if (!href) return;
        const item = { kind: "image", text: "", src: "" };
        items.push(item);
        pending.push(zip.bytes(href).then((b) => { if (b) item.src = blobUrl(b); }));
      });
    };
    const walk = (n) => {
      for (const c of n.children) {
        const t = c.localName;
        if (t === "h") {
          const text = norm(textOf(c));
          const level = Number(c.getAttribute("text:outline-level") || 1);
          if (text) { toc.push({ title: text, level, item: items.length }); items.push({ kind: "title", text, level }); }
        } else if (t === "p") {
          acc = new StyleAcc(); ctx = resolve(c.getAttribute("text:style-name"), { fs: 1, b: false });
          const text = norm(textOf(c));
          if (text) items.push(withSt({ kind: "p", text }, acc.get()));
          acc = null;
        } else if (t === "table-row") {
          items.push({ kind: "p", text: Array.from(c.children).map((cell) => norm(cell.textContent)).filter(Boolean).join(" | "), cls: "table" });
        } else if (t !== "tracked-changes" && t !== "sequence-decls") walk(c);
      }
    };
    const body = doc.getElementsByTagNameNS("*", "text")[0];
    if (body) walk(body);
    await Promise.all(pending);
    const metaXml = await zip.text("meta.xml");
    const meta = metaXml ? parseXml(metaXml) : null;
    const fn = titleFromFileName(name);
    const title = meta && norm((meta.getElementsByTagNameNS("*", "title")[0] || {}).textContent) || fn.title;
    const creator = meta && norm(((meta.getElementsByTagNameNS("*", "initial-creator")[0] || meta.getElementsByTagNameNS("*", "creator")[0]) || {}).textContent);
    return { title, authors: creator ? [creator] : fn.authors, annotation: [], cover: null, items: items.filter((i) => i.kind !== "image" || i.src), toc };
  }

  // ---------- RTF ----------
  function parseRtf(bytes, name) {
    const src = new TextDecoder("latin1").decode(bytes);
    const cpMatch = src.match(/\\ansicpg(\d+)/);
    let codepage = "windows-" + (cpMatch ? cpMatch[1] : "1251");
    let decoder;
    try { decoder = new TextDecoder(codepage); } catch (_) { decoder = new TextDecoder("windows-1251"); }
    const SKIP_DEST = new Set(["fonttbl", "colortbl", "stylesheet", "pict", "header", "footer", "headerl", "headerr", "footerl", "footerr",
      "footnote", "object", "themedata", "datastore", "latentstyles", "listtable", "listoverridetable", "rsidtbl", "generator",
      "xmlnstbl", "mmathPr", "fldinst", "listtext", "pntext", "pntxta", "pntxtb", "field_inst", "bkmkstart", "bkmkend", "nonshppict",
      "shp", "shpinst", "operator", "company", "comment", "doccomm", "keywords", "subject", "category", "manager", "printim",
      "revtim", "creatim", "buptim", "filetbl", "revtbl", "info_other", "fldrslt_skip"]);
    const SYM = { emdash: "—", endash: "–", lquote: "‘", rquote: "’", ldblquote: "“", rdblquote: "”", bullet: "•", tab: " ", line: "\n" };
    const paras = [], paraSt = [];
    let cur = "", bytesBuf = [], acc = new StyleAcc();
    const endPara = () => { paras.push(cur); paraSt.push(acc.get()); cur = ""; acc = new StyleAcc(); };
    const info = { title: "", author: "" };
    const stack = [];
    let state = { skip: false, uc: 1, dest: null, fs: 24, b: false };   // fs — \fsN, в полупунктах
    let ucSkip = 0;
    const flushBytes = () => { if (bytesBuf.length) { const s = decoder.decode(new Uint8Array(bytesBuf)); bytesBuf = []; emit(s); } };
    const emit = (s) => {
      if (state.dest === "title") info.title += s;
      else if (state.dest === "author") info.author += s;
      else if (!state.skip) { cur += s; acc.add(state.fs / 2, state.b, s.replace(/\s+/g, "").length); }
    };
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "{") { flushBytes(); stack.push(state); state = { ...state }; i++; continue; }
      if (ch === "}") { flushBytes(); state = stack.pop() || { skip: false, uc: 1, dest: null, fs: 24, b: false }; i++; continue; }
      if (ch === "\\") {
        const nx = src[i + 1];
        if (nx === "'") {
          if (ucSkip > 0) { ucSkip--; i += 4; continue; }
          bytesBuf.push(parseInt(src.substr(i + 2, 2), 16)); i += 4; continue;
        }
        flushBytes();
        if (nx === "*") { state.skip = true; i += 2; continue; }
        if (nx === "\\" || nx === "{" || nx === "}") { emit(nx); i += 2; continue; }
        if (nx === "~") { emit(" "); i += 2; continue; }
        if (nx === "-") { i += 2; continue; }
        if (nx === "_") { emit("-"); i += 2; continue; }
        if (nx === "\n" || nx === "\r") { endPara(); i += 2; continue; }
        const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i + 1, i + 40));
        if (!m) { i++; continue; }
        const word = m[1], arg = m[2] !== undefined ? Number(m[2]) : null;
        i += 1 + m[0].length;
        if (word === "ud") { state.skip = false; state.ud = true; }
        else if (word === "upr") { /* ansi + unicode варианты: берём unicode из \ud */ }
        else if (SKIP_DEST.has(word)) state.skip = true;
        else if (word === "info") state.dest = "info";
        else if (word === "title" && (state.dest === "info" || state.ud)) { state.dest = "title"; if (state.ud) info.title = ""; }
        else if (word === "author" && (state.dest === "info" || state.ud)) { state.dest = "author"; if (state.ud) info.author = ""; }
        else if (word === "par" || word === "sect" || word === "page") { if (!state.skip && !state.dest) endPara(); }
        else if (word === "fs") state.fs = arg || 24;
        else if (word === "b") state.b = arg !== 0;
        else if (word === "plain") { state.fs = 24; state.b = false; }
        else if (word === "uc") state.uc = arg || 0;
        else if (word === "u") { emit(String.fromCharCode(arg < 0 ? arg + 65536 : arg)); ucSkip = state.uc; }
        else if (SYM[word]) emit(SYM[word]);
        else if (word === "ansicpg") { try { decoder = new TextDecoder("windows-" + arg); } catch (_) {} }
        continue;
      }
      if (ch === "\r" || ch === "\n") { i++; continue; }
      if (ucSkip > 0) { ucSkip--; i++; continue; }
      flushBytes();
      if (state.dest !== "info") emit(ch);
      i++;
    }
    flushBytes();
    endPara();
    const items = [], toc = [];
    paras.forEach((raw, k) => {
      for (const line of raw.split("\n")) {
        const t = norm(line);
        if (!t) continue;
        if (isHeadingLine(t)) { toc.push({ title: t, level: 1, item: items.length }); items.push({ kind: "title", text: t, level: 1 }); }
        else items.push(withSt({ kind: "p", text: t }, paraSt[k]));
      }
    });
    const fn = titleFromFileName(name);
    return { title: norm(info.title) || fn.title, authors: norm(info.author) ? [norm(info.author)] : fn.authors, annotation: [], cover: null, items, toc };
  }

  // ---------- MOBI / AZW / PRC ----------
  function palmDocDecompress(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i++];
      if (c === 0 || (c >= 0x09 && c <= 0x7f)) out.push(c);
      else if (c >= 1 && c <= 8) { for (let k = 0; k < c && i < src.length; k++) out.push(src[i++]); }
      else if (c >= 0x80 && c <= 0xbf) {
        const n = src[i++];
        const pair = (c << 8) | n;
        const dist = (pair >> 3) & 0x7ff, len = (pair & 7) + 3;
        const start = out.length - dist;
        for (let k = 0; k < len; k++) out.push(out[start + k]);
      } else { out.push(0x20, c ^ 0x80); }
    }
    return new Uint8Array(out);
  }

  function trailingSize(rec, flags) {
    let num = 0;
    const size = rec.length;
    let f = flags >> 1;
    while (f) {
      if (f & 1) {
        let pos = size - num, bitpos = 0, result = 0;
        while (pos > 0) {
          const v = rec[pos - 1];
          result |= (v & 0x7f) << bitpos;
          bitpos += 7; pos--;
          if ((v & 0x80) || bitpos >= 28) break;
        }
        num += result;
      }
      f >>= 1;
    }
    if (flags & 1) num += (rec[size - num - 1] & 0x3) + 1;
    return num;
  }

  async function parseMobi(buf, name) {
    const u8 = new Uint8Array(buf);
    const v = new DataView(buf);
    const numRecords = v.getUint16(76);
    const offs = [];
    for (let k = 0; k < numRecords; k++) offs.push(v.getUint32(78 + k * 8));
    offs.push(buf.byteLength);
    const record = (k) => u8.subarray(offs[k], offs[k + 1]);
    const r0 = offs[0];
    const compression = v.getUint16(r0);
    const textRecords = v.getUint16(r0 + 8);
    const encryption = v.getUint16(r0 + 12);
    if (encryption) throw new Error("Книга защищена DRM — открыть её нельзя");
    if (compression === 17480) throw new Error("Сжатие HUFF/CDIC в MOBI пока не поддерживается");
    const ident = new TextDecoder("latin1").decode(u8.subarray(r0 + 16, r0 + 20));
    let encoding = "windows-1252", firstImage = 0, extraFlags = 0, title = "", authors = [], annotation = [], coverIdx = null;
    if (ident === "MOBI") {
      const hlen = v.getUint32(r0 + 20);
      encoding = v.getUint32(r0 + 28) === 65001 ? "utf-8" : "windows-1252";
      const fnOff = v.getUint32(r0 + 84), fnLen = v.getUint32(r0 + 88);
      title = new TextDecoder(encoding).decode(u8.subarray(r0 + fnOff, r0 + fnOff + fnLen));
      firstImage = v.getUint32(r0 + 108);
      if (hlen >= 0xe4) extraFlags = v.getUint16(r0 + 16 + 0xe2);
      const exthFlags = v.getUint32(r0 + 128);
      if (exthFlags & 0x40) {
        let p = r0 + 16 + hlen;
        if (new TextDecoder("latin1").decode(u8.subarray(p, p + 4)) === "EXTH") {
          const count = v.getUint32(p + 8);
          p += 12;
          for (let k = 0; k < count; k++) {
            const type = v.getUint32(p), len = v.getUint32(p + 4);
            const data = u8.subarray(p + 8, p + len);
            const str = () => new TextDecoder(encoding).decode(data);
            if (type === 100) authors.push(norm(str()));
            else if (type === 503) title = str();
            else if (type === 103) annotation.push(norm(new DOMParser().parseFromString(str(), "text/html").body.textContent));
            else if (type === 201) coverIdx = v.getUint32(p + 8);
            p += len;
          }
        }
      }
    }
    const parts = [];
    for (let k = 1; k <= textRecords && k < numRecords; k++) {
      let rec = record(k);
      if (extraFlags) rec = rec.subarray(0, rec.length - trailingSize(rec, extraFlags));
      parts.push(compression === 2 ? palmDocDecompress(rec) : rec);
    }
    const total = parts.reduce((s, p) => s + p.length, 0);
    const all = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    let html = new TextDecoder(encoding).decode(all);
    const isHtml = /<(html|body|p|div|h\d)[\s>]/i.test(html.slice(0, 5000));
    const imageAt = (idx) => {
      const k = firstImage + idx;
      if (!firstImage || k >= numRecords) return null;
      const b = record(k);
      return sniffImage(b) ? blobUrl(b) : null;
    };
    const cover = coverIdx !== null ? imageAt(coverIdx) : null;
    const fn = titleFromFileName(name);
    if (!isHtml) {
      const b = parseTxt(new TextEncoder().encode(html), name);
      return { ...b, title: norm(title) || b.title, authors: authors.length ? authors : b.authors, cover, annotation };
    }
    html = html.replace(/<mbp:pagebreak\s*\/?>/gi, "<hr/>");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const c = new HtmlCollector((src) => {
      let m = src.match(/^recindex:(\d+)/);
      if (m) return imageAt(Number(m[1]) - 1);
      m = src.match(/kindle:embed:([0-9A-V]+)/i);
      if (m) return imageAt(parseInt(m[1], 32) - 1);
      return null;
    });
    c.add(doc, "");
    await c.done();
    return { title: norm(title) || fn.title, authors: authors.length ? authors : fn.authors, annotation, cover, items: c.items, toc: c.headings };
  }

  // ---------- PDF (pdf.js лежит в web/vendor/pdfjs) ----------
  let pdfjs = null;
  async function loadPdfJs() {
    if (pdfjs) return pdfjs;
    pdfjs = await import("./vendor/pdfjs/pdf.min.js");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.js", document.baseURI).href;
    return pdfjs;
  }

  async function parsePdf(buf, name, onProgress) {
    const lib = await loadPdfJs();
    const pdf = await lib.getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false }).promise;
    const fn = titleFromFileName(name);
    let title = fn.title, authors = fn.authors;
    try {
      const meta = await pdf.getMetadata();
      if (meta.info && norm(meta.info.Title)) title = norm(meta.info.Title);
      if (meta.info && norm(meta.info.Author)) authors = [norm(meta.info.Author)];
    } catch (_) {}

    // закладки заранее: страница → заголовки, чтобы вынести их отдельными строками
    const outlineFlat = [];
    try {
      const walk = async (nodes, level) => {
        for (const n of nodes || []) {
          let page = null;
          try {
            let dest = n.dest;
            if (typeof dest === "string") dest = await pdf.getDestination(dest);
            if (dest && dest[0] !== undefined) page = typeof dest[0] === "number" ? dest[0] : await pdf.getPageIndex(dest[0]);
          } catch (_) {}
          outlineFlat.push({ title: norm(n.title), level, page });
          await walk(n.items, level + 1);
        }
      };
      await walk(await pdf.getOutline(), 1);
    } catch (_) {}
    const key = (t) => norm(t).toLowerCase().replace(/[^a-zа-яё0-9]+/g, "");
    const outlineByKey = new Map(outlineFlat.filter((o) => o.title).map((o) => [key(o.title), o]));

    const items = [];
    const toc = [];
    const pageStart = [];
    let textChars = 0;
    for (let pn = 1; pn <= pdf.numPages; pn++) {
      if (onProgress && (pn === 1 || pn % 10 === 0)) onProgress(`PDF: страница ${pn} из ${pdf.numPages}`);
      const page = await pdf.getPage(pn);
      const content = await page.getTextContent();
      pageStart.push(items.length);
      // строки по координате y, слова в строке — по x
      const glyphs = content.items.filter((it) => "str" in it && it.str.trim()).map((it) => ({
        s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, h: Math.abs(it.transform[3]) || it.height || 10,
      }));
      glyphs.sort((p, q) => q.y - p.y || p.x - q.x);
      const lines = [];
      for (const g of glyphs) {
        const line = lines.length ? lines[lines.length - 1] : null;
        if (line && Math.abs(line.y - g.y) < Math.max(2, Math.min(line.h, g.h) * 0.5)) line.parts.push(g), line.h = Math.max(line.h, g.h);
        else lines.push({ y: g.y, h: g.h, parts: [g] });
      }
      for (const l of lines) {
        l.parts.sort((p, q) => p.x - q.x);
        let t = "", end = null;
        for (const p of l.parts) {
          if (end !== null && p.x - end > p.h * 0.12 && !/\s$/.test(t) && !/^\s/.test(p.s)) t += " ";
          t += p.s;
          end = p.x + p.w;
        }
        l.text = norm(t);
        l.x = l.parts[0].x;
      }
      const clean = lines.filter((l) => l.text && !/^[-–—]?\s*\d{1,4}\s*[-–—]?$/.test(l.text));
      if (!clean.length) continue;
      const hs = clean.map((l) => l.h).sort((a, b) => a - b);
      const bodyH = hs[Math.floor(hs.length / 2)];
      const gaps = [];
      for (let k = 1; k < clean.length; k++) gaps.push(clean[k - 1].y - clean[k].y);
      const sorted = gaps.filter((g) => g > 0).sort((a, b) => a - b);
      const lineGap = sorted.length ? sorted[Math.floor(sorted.length / 2)] : bodyH * 1.3;
      const lens = clean.map((l) => l.text.length).sort((a, b) => a - b);
      const fullLen = lens[Math.floor(lens.length * 0.8)] || 60;
      const xs = clean.map((l) => l.x).sort((a, b) => a - b);
      const leftX = xs[Math.floor(xs.length * 0.2)] || 0;
      let para = "";
      const flush = () => {
        const t = norm(para);
        if (t) { items.push({ kind: "p", text: t }); textChars += t.length; }
        para = "";
      };
      clean.forEach((l, k) => {
        const t = l.text;
        const o = outlineByKey.get(key(t));
        const big = l.h > bodyH * 1.25 && t.length < 90;
        if (o || big) {
          flush();
          const level = o ? o.level : (l.h > bodyH * 1.6 ? 1 : 2);
          const prevItem = items[items.length - 1];
          if (big && !o && prevItem && prevItem.kind === "title" && prevItem._y - l.y < l.h * 1.8) { prevItem.text += " " + t; prevItem._y = l.y; return; }
          toc.push({ title: t, level, item: items.length });
          items.push({ kind: "title", text: t, level, _y: l.y });
          if (o) outlineByKey.delete(key(t));
          return;
        }
        const prev = clean[k - 1];
        if (prev && para) {
          const gap = prev.y - l.y;
          const prevT = prev.text;
          const indented = l.x - leftX > bodyH * 0.8;
          const prevShort = prevT.length < fullLen * 0.75 && /[.!?…:»"”)]$/.test(prevT);
          if (gap > lineGap * 1.5 || (indented && /[.!?…:»"”)]$/.test(prevT)) || prevShort) flush();
        }
        if (/[a-zа-яё]-$/i.test(para) && /^[a-zа-яё]/.test(t)) para = para.slice(0, -1) + t;
        else para += (para ? " " : "") + t;
      });
      flush();
    }
    if (textChars < 50) throw new Error("В этом PDF нет текстового слоя (скан) — озвучить нельзя");

    // закладки, которые не нашлись в тексте, — привязываем к началу их страницы
    for (const o of outlineByKey.values()) {
      if (o.page !== null && pageStart[o.page] !== undefined) toc.push({ title: o.title, level: o.level, item: Math.min(pageStart[o.page], items.length - 1) });
    }
    toc.sort((p, q) => p.item - q.item);
    if (!toc.length) items.forEach((it, i) => { if (it.kind === "p" && isHeadingLine(it.text) && it.text.length < 60) { it.kind = "title"; it.level = 1; toc.push({ title: it.text, level: 1, item: i }); } });
    items.forEach((it) => delete it._y);
    return { title, authors, annotation: [], cover: null, items, toc };
  }

  // ---------- определение формата ----------
  const LABEL = { fb2: "FB2", epub: "EPUB", txt: "TXT", md: "MD", html: "HTML", docx: "DOCX", odt: "ODT", rtf: "RTF", mobi: "MOBI", pdf: "PDF" };
  const SUPPORTED = ".fb2,.zip,.epub,.txt,.md,.html,.htm,.xhtml,.docx,.odt,.rtf,.mobi,.azw,.azw3,.prc,.pdf";

  // ошибки библиотек (pdf.js, DOM) приходят по-английски — показываем человеку понятный текст
  async function parseBuffer(buf, name, onProgress, depth = 0) {
    try {
      return await parseBufferRaw(buf, name, onProgress, depth);
    } catch (e) {
      const msg = String((e && e.message) || e || "");
      if (/[а-яё]/i.test(msg)) throw e;
      if (e && e.name === "PasswordException") throw new Error("PDF защищён паролем — откройте его без пароля и сохраните заново");
      if (/pdf/i.test(msg) || extOf(name) === "pdf") throw new Error("PDF повреждён или не является PDF — открыть не получилось");
      if (e instanceof RangeError || /memory|allocation/i.test(msg)) throw new Error("Файл слишком большой для этого устройства");
      throw new Error("Файл повреждён или его формат не поддерживается" + (msg ? ` (${msg.slice(0, 80)})` : ""));
    }
  }

  async function parseBufferRaw(buf, name, onProgress, depth = 0) {
    const u8 = new Uint8Array(buf);
    if (!u8.length) throw new Error("Файл пустой");
    const head = new TextDecoder("latin1").decode(u8.subarray(0, Math.min(1024, u8.length)));
    const ext = extOf(name);
    let fmt, book;

    if (Zip.isZip(buf)) {
      const zip = Zip.open(buf);
      if (zip.has("META-INF/container.xml") || ext === "epub") { fmt = "epub"; book = await parseEpub(zip, name); }
      else if (zip.has("word/document.xml")) { fmt = "docx"; book = await parseDocx(zip, name); }
      else if (zip.has("content.xml")) { fmt = "odt"; book = await parseOdt(zip, name); }
      else {
        const BOOK_RE = /\.(fb2|epub|txt|rtf|docx|odt|html?|xhtml|md|mobi|azw3?|prc|pdf)$/i;
        let inners = zip.names.filter((n) => BOOK_RE.test(n) && !/(^|\/)(__MACOSX|\.)/.test(n));
        // книги одного формата: есть FB2 — только они, иначе самый частый формат (а не readme.txt рядом с книгой)
        const count = new Map();
        inners.forEach((n) => count.set(extOf(n), (count.get(extOf(n)) || 0) + 1));
        const main = count.has("fb2") ? "fb2" : [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        inners = inners.filter((n) => extOf(n) === main);
        if (!inners.length || depth > 1) throw new Error("В архиве нет поддерживаемой книги");
        if (inners.length === 1) {
          const b = await zip.bytes(inners[0]);
          return parseBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), inners[0].split("/").pop(), onProgress, depth + 1);
        }
        // несколько книг в архиве (например, по файлу на главу) — собираем одну книгу, файлы — главы
        return assemble(zip, inners, name, onProgress, depth);
      }
    } else if (head.startsWith("%PDF")) { fmt = "pdf"; book = await parsePdf(buf, name, onProgress); }
    else if (u8.length > 68 && /BOOKMOBI|TEXtREAd/.test(head.slice(60, 68))) { fmt = "mobi"; book = await parseMobi(buf, name); }
    else if (head.startsWith("{\\rtf")) { fmt = "rtf"; book = parseRtf(u8, name); }
    else if (/<FictionBook/.test(head) || ext === "fb2") { fmt = "fb2"; book = await FB2.parse(buf, name); }
    else if (/^(html?|xhtml)$/.test(ext) || /^\s*(<!doctype html|<html|<\?xml[^>]*>\s*<html)/i.test(head.replace(/^﻿/, ""))) { fmt = "html"; book = await parseHtml(u8, name); }
    else if (ext === "md") { fmt = "md"; book = parseTxt(u8, name, true); }
    else if (/\x00/.test(head.slice(0, 512)) && !/^(\xff\xfe|\xfe\xff)/.test(head)) throw new Error("Неизвестный двоичный формат");
    else { fmt = "txt"; book = parseTxt(u8, name); }

    book.format = fmt;
    book.formatLabel = LABEL[fmt] || fmt.toUpperCase();
    dropLeadingDuplicates(book);
    if (!book.items.length) throw new Error("В книге не найден текст");
    return book;
  }

  // ---------- одна книга из многих файлов ----------
  // Порядок — по именам файлов «по-человечески»: 2.fb2 раньше 10.fb2 (числа сравниваются как числа).
  // Каждый файл — глава. Её заголовок: свой заголовок файла (если файл с него начинается), иначе название
  // книги из файла (если у всех файлов они разные), иначе имя файла.
  const natCollator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });
  const natCompare = (a, b) => natCollator.compare(a, b);
  async function assemble(zip, names, zipName, onProgress, depth) {
    names = names.slice().sort(natCompare);
    const parts = [];
    for (const [k, n] of names.entries()) {
      if (onProgress && (k === 0 || k % 20 === 0)) onProgress(`Собираю книгу из ${names.length} файлов: ${k + 1}…`);
      const b = await zip.bytes(n);
      try {
        const book = await parseBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), n.split("/").pop(), null, depth + 1);
        parts.push({ name: n, book });
      } catch (_) { /* битый файл внутри — пропускаем, остальные главы остаются */ }
    }
    if (!parts.length) throw new Error("В архиве нет книг, которые получилось открыть");
    if (parts.length === 1) return parts[0].book;
    // имена файлов → названия глав: «Книга_Глава_1._Название.docx» → «Глава 1. Название» (общая часть имён убирается)
    const clean = parts.map((p) => norm(baseName(p.name.split("/").pop()).replace(/_/g, " ")));
    const heads = clean.map((c) => { const m = c.match(/(^|[\s.])(глава|часть|chapter|part|том)(?=[\s\d.]|$)|\d/i); return m ? c.slice(0, m.index + (m[1] ? 1 : 0)) : ""; });
    const freq = new Map(); heads.forEach((h) => freq.set(h, (freq.get(h) || 0) + 1));
    const [pre, cnt] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
    const prefix = pre.trim() && cnt >= Math.max(2, parts.length / 2) ? pre : "";
    const fileTitle = (k) => {
      const t = (prefix && clean[k].startsWith(prefix) ? clean[k].slice(prefix.length) : clean[k]).replace(/^[\s.—–-]+|[\s.—–-]+$/g, "") || clean[k];
      return /^(\d+|[IVXLC]+)$/.test(t) ? "Глава " + t : t;   // остался только номер — «Глава 7»
    };
    const titles = new Set(parts.map((p) => p.book.title));
    // название из файла, совпадающее с именем файла (у DOCX/TXT без метаданных), за название главы не считаем
    const distinct = titles.size === parts.length && parts.every((p) => p.book.title !== titleFromFileName(p.name.split("/").pop()).title);
    const items = [], toc = [];
    for (const [k, p] of parts.entries()) {
      const b = p.book, base = items.length;
      const own = b.items[0] && b.items[0].kind === "title";
      if (!own) {
        const t = distinct ? b.title : fileTitle(k);
        toc.push({ title: t, level: 1, item: base });
        items.push({ kind: "title", text: t, level: 1 });
      }
      const shift = own ? 0 : 1, at = items.length;
      for (const it of b.items) items.push(it.kind === "title" ? Object.assign({}, it, { level: (it.level || 1) + shift }) : it);
      for (const t of b.toc) toc.push({ title: t.title, level: t.level + shift, item: at + t.item });
    }
    const first = parts[0].book;
    const fn = titleFromFileName(zipName);
    return {
      title: titles.size === 1 ? first.title : prefix.replace(/[\s.—–-]+$/, "") || fn.title, authors: first.authors.length ? first.authors : fn.authors,
      annotation: first.annotation || [], cover: (parts.find((p) => p.book.cover) || { book: {} }).book.cover || null,
      items, toc, assembled: parts.length, format: first.format, formatLabel: (first.formatLabel || "") + " ×" + parts.length,
    };
  }

  // первые абзацы, повторяющие название и автора (они уже в шапке книги), убираем
  function dropLeadingDuplicates(book) {
    const key = (t) => norm(t).toLowerCase().replace(/[^a-zа-яё0-9]+/g, "");
    const known = new Set([key(book.title), key(book.authors.join(", ")), ...book.authors.map(key)].filter(Boolean));
    let n = 0;
    while (n < 3 && n < book.items.length - 1 && book.items[n].kind !== "image" && known.has(key(book.items[n].text))) n++;
    if (!n) return;
    book.items = book.items.slice(n);
    book.toc = book.toc.filter((t) => t.item >= n).map((t) => ({ ...t, item: t.item - n }));
  }

  // ---------- поиск глав, если в книге нет оглавления ----------
  // Варианты разметки (пользователь выбирает и видит, что получится):
  //  • строки вида «Глава 1», «Часть II», «Пролог» — короткий абзац, который начинается с такого слова (и номера);
  //  • оформление: короткие абзацы, набранные крупнее основного текста или жирным. Основной текст — тот размер,
  //    которым набрано больше всего букв (не самый мелкий: сноски бывают ещё мельче); всё, что не крупнее его, —
  //    не заголовки. Оформление, встретившееся один раз (обычно название книги), не предлагаем;
  //  • подзаголовки FB2 (subtitle); • строки из одного номера («1», «IV»), если номера идут по порядку.
  const CHAP_KW = /^(глава|часть|книга|том|chapter|part|book|volume)\s*(№\s*)?(\d{1,4}|[ivxlcdm]{1,8}|перв\S*|втор\S*|трет\S*|четв[её]рт\S*|пят\S*|шест\S*|седьм\S*|восьм\S*|девят\S*|десят\S*|one|two|three|four|five|first|second|third)(?=$|[\s.,:;!?)—–-])/i;
  const CHAP_SOLO = /^(пролог|эпилог|предисловие|послесловие|вступление|заключение|интерлюдия|prologue|epilogue|interlude|preface|afterword|introduction)(?=$|[\s.,:;!?—–-])/i;
  const PART_KW = /^(часть|книга|том|part|book|volume)/i;
  const NUM_ONLY = /^(\d{1,4}|[IVXLCDM]{1,8})\.?$/;
  const romanVal = (r) => { const v = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }; let n = 0; for (let k = 0; k < r.length; k++) { const a = v[r[k]], b = v[r[k + 1]] || 0; n += a < b ? -a : a; } return n; };
  const fmtX = (x) => String(Math.round(x * 10) / 10).replace(".", ",");

  function findChapters(book) {
    const items = book.items;
    const isText = (it) => it.kind === "p" || it.kind === "subtitle";
    const variants = [];
    const entry = (i, level) => ({ i, level, text: items[i].text });

    // 1) «Глава 1», «Часть II», «Пролог»
    const pat = [];
    items.forEach((it, i) => {
      if (!isText(it) || it.text.length > 100) return;
      if (CHAP_KW.test(it.text) || CHAP_SOLO.test(it.text)) pat.push(i);
    });
    if (pat.length >= 2) {
      const hasParts = pat.some((i) => PART_KW.test(items[i].text)), hasCh = pat.some((i) => !PART_KW.test(items[i].text));
      variants.push({ id: "pattern", label: "Строки «Глава 1», «Часть II», «Пролог»", entries: pat.map((i) => entry(i, hasParts && hasCh && !PART_KW.test(items[i].text) ? 2 : 1)) });
    }

    // 2) оформление
    const paras = items.filter((it) => it.kind === "p");
    // размер у абзаца без пометки — обычный (1), если размеры в книге вообще известны (HTML/EPUB: пометки только у особых)
    const hasFs = paras.some((it) => it.st && it.st.fs);
    const fsOf = (it) => (it.st && it.st.fs) || (hasFs ? 1 : 0);
    const chars = new Map();
    let boldChars = 0, allChars = 0;
    for (const it of paras) {
      const fs = fsOf(it), n = it.text.length;
      chars.set(fs, (chars.get(fs) || 0) + n); allChars += n;
      if (it.st && it.st.b) boldChars += n;
    }
    let bodyFs = 0, best = -1;
    for (const [fs, n] of chars) if (n > best) { best = n; bodyFs = fs; }
    const bodyBold = boldChars > allChars * 0.5;
    const groups = new Map();
    items.forEach((it, i) => {
      if (it.kind !== "p" || it.text.length > 120 || !it.st) return;
      const fs = fsOf(it), b = !!it.st.b;
      const bigger = bodyFs > 0 && fs > bodyFs * 1.05;
      const sameSize = !bodyFs || !fs || Math.abs(fs - bodyFs) <= bodyFs * 0.05;
      if (!(bigger || (b && !bodyBold && sameSize))) return;
      const key = (bigger ? Math.round(fs * 100) / 100 : 0) + "|" + (b ? 1 : 0);
      if (!groups.has(key)) groups.set(key, { fs: bigger ? fs : 0, b, idx: [] });
      groups.get(key).idx.push(i);
    });
    [...groups.values()]
      .filter((g) => g.idx.length >= 2 && g.idx.length <= paras.length * 0.3 &&
        g.idx.reduce((a, i) => a + items[i].text.length, 0) / g.idx.length <= 80)
      .sort((x, y) => y.fs - x.fs || Number(y.b) - Number(x.b))
      .forEach((g) => {
        const size = g.fs ? `крупнее текста в ${fmtX(g.fs / bodyFs)} раза` : "размер как у текста";
        const label = g.b ? "Жирный шрифт, " + size : "Шрифт " + size;
        variants.push({ id: "style:" + g.fs + "|" + (g.b ? 1 : 0), fs: g.fs, label, entries: g.idx.map((i) => entry(i, 1)) });
      });

    // 3) подзаголовки FB2
    const subs = [];
    items.forEach((it, i) => { if (it.kind === "subtitle" && it.text.length <= 120) subs.push(i); });
    if (subs.length >= 2) variants.push({ id: "subtitle", label: "Подзаголовки книги", entries: subs.map((i) => entry(i, 1)) });

    // 4) строки-номера, идущие по порядку
    const nums = [];
    items.forEach((it, i) => { if (isText(it) && NUM_ONLY.test(it.text)) nums.push(i); });
    if (nums.length >= 3) {
      const val = (i) => { const t = items[i].text.replace(/\.$/, ""); return /^\d+$/.test(t) ? Number(t) : romanVal(t); };
      let up = 0;
      for (let k = 1; k < nums.length; k++) if (val(nums[k]) === val(nums[k - 1]) + 1) up++;
      if (up >= (nums.length - 1) * 0.6) variants.push({ id: "numbers", label: "Строки из одного номера («1», «IV»)", entries: nums.map((i) => entry(i, 1)) });
    }

    // заголовки, которые в книге уже есть (например, книга собрана из файлов «по 5 глав»: заголовок файла —
    // первая глава пачки, остальные — простым текстом). Их нельзя терять: найденное добавляется к ним
    const own = (book.toc || []).filter((t) => items[t.item]);
    if (own.length && variants.length) {
      variants.unshift({ id: "toc", label: "Заголовки, которые уже есть в книге", entries: own.map((t) => ({ i: t.item, level: t.level || 1, text: t.title })), checked: true });
    }
    variants.forEach((v) => { v.count = v.entries.length; });
    const rec = variants.find((v) => v.id !== "toc" && v.count >= 3) || variants.find((v) => v.id !== "toc");
    if (rec) rec.recommended = true;
    return { variants, itemCount: items.length, bodyFs };
  }

  // несколько вариантов вместе: уровни — по порядку (крупный шрифт — разделы, мельче — главы), повторы убираются
  function mergeChapters(variants) {
    const byI = new Map();
    // уровни: шрифтовые варианты — по размеру (самый крупный — разделы, мельче — главы внутри),
    // остальные (строки «Глава N», готовые заголовки книги) — со своими уровнями, рядом друг с другом
    const styles = variants.filter((v) => v.fs).sort((a, b) => b.fs - a.fs);
    variants.forEach((v) => v.entries.forEach((e) => {
      const rank = v.fs ? styles.indexOf(v) : 0;
      const level = Math.min(3, rank + e.level);
      if (!byI.has(e.i) || byI.get(e.i).level > level) byI.set(e.i, { i: e.i, level, text: e.text });
    }));
    return [...byI.values()].sort((a, b) => a.i - b.i);
  }

  // сохранённая разметка → книга: абзацы становятся заголовками, оглавление — из них
  function applyChapters(book, saved) {
    if (!saved || !Array.isArray(saved.list) || saved.n !== book.items.length) return false;
    const toc = [];
    for (const [i, level] of saved.list) {
      const it = book.items[i];
      if (!it || !it.text || it.kind === "image") continue;
      it.kind = "title"; it.level = level || 1; delete it.cls;
      toc.push({ title: it.text, level: it.level, item: i });
    }
    if (!toc.length) return false;
    book.toc = toc;
    book.autoToc = true;
    return true;
  }

  async function parseFile(file, onProgress) {
    return parseBuffer(await file.arrayBuffer(), file.name, onProgress);
  }

  window.Books = { parseFile, parseBuffer, SUPPORTED, findChapters, mergeChapters, applyChapters, _test: { palmDocDecompress, parseRtf, parseTxt, decodeText } };
})();
