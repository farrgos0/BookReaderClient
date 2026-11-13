// Библиотека книг: файлы и карточки в IndexedDB браузера.
// Карточка: { id, title, authors, format, formatLabel, name, size, addedAt, openedAt, pos, segCount, progress, cover }
(function () {
  "use strict";
  const DB = "fb2reader", VER = 2;
  let dbp = null;

  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("books")) d.createObjectStore("books"); // старая версия (одна «last»)
        if (!d.objectStoreNames.contains("library")) d.createObjectStore("library", { keyPath: "id" });
        if (!d.objectStoreNames.contains("files")) d.createObjectStore("files");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }

  function req(store, mode, fn) {
    return db().then((d) => new Promise((res, rej) => {
      const tx = d.transaction(store, mode);
      let out;
      const r = fn(tx.objectStore(Array.isArray(store) ? store[0] : store), tx);
      if (r && "onsuccess" in r) r.onsuccess = () => { out = r.result; };
      tx.oncomplete = () => res(out);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error("Операция с хранилищем отменена"));
    }));
  }

  async function fileId(buf, file) {
    try {
      const h = await crypto.subtle.digest("SHA-256", buf);
      return Array.from(new Uint8Array(h).slice(0, 10)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch (_) {
      return "f" + (file.name + file.size + (file.lastModified || 0)).split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16);
    }
  }

  function thumbnail(src) {
    return new Promise((res) => {
      if (!src) return res(null);
      const img = new Image();
      img.onload = () => {
        try {
          const w = 120, h = Math.round((img.naturalHeight / img.naturalWidth) * w) || 170;
          const c = document.createElement("canvas");
          c.width = w; c.height = Math.min(h, 200);
          c.getContext("2d").drawImage(img, 0, 0, w, h);
          res(c.toDataURL("image/jpeg", 0.75));
        } catch (_) { res(null); }
      };
      img.onerror = () => res(null);
      img.src = src;
    });
  }

  async function audioId(blob, name) {
    const N = 256 * 1024;
    const head = new Uint8Array(await blob.slice(0, N).arrayBuffer());
    const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - N)).arrayBuffer());
    const sig = new TextEncoder().encode(blob.size + "|");
    const all = new Uint8Array(sig.length + head.length + tail.length);
    all.set(sig); all.set(head, sig.length); all.set(tail, sig.length + head.length);
    try {
      const h = await crypto.subtle.digest("SHA-256", all);
      return "a" + Array.from(new Uint8Array(h).slice(0, 10)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch (_) {
      return "a" + (name + blob.size).split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16);
    }
  }
  // карточка аудиокниги (общая с приложением: native.js)
  function audioMeta(id, name, size, book, cover) {
    return {
      id, title: book.title, authors: book.authors, format: "audio", formatLabel: audioLabel(book), name, size,
      addedAt: Date.now(), openedAt: Date.now(), pos: 0, segCount: 0, progress: 0, cover: cover || null,
      audio: audioInfo(book), apos: 0,
    };
  }
  const audioLabel = (book) => ((book.parts[0] && AudioMeta.ext(book.parts[0].name)) || "audio").toUpperCase();
  const audioInfo = (book) => ({ duration: book.duration, parts: book.parts, chapters: book.chapters });
  window.AudioCard = { audioLabel, audioInfo };

  const Library = {
    thumbnail,
    async list() {
      return (await req("library", "readonly", (s) => s.getAll())) || [];
    },
    async get(id) {
      return req("library", "readonly", (s) => s.get(id));
    },
    async getFile(id) {
      return req("files", "readonly", (s) => s.get(id));
    },
    async update(id, patch) {
      const d = await db();
      return new Promise((res, rej) => {
        const tx = d.transaction("library", "readwrite");
        const st = tx.objectStore("library");
        const g = st.get(id);
        g.onsuccess = () => { if (g.result) st.put(Object.assign(g.result, patch)); };
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    },
    // добавить файл (если такой уже есть — вернуть существующую карточку)
    async add(file, buf, book) {
      const id = await fileId(buf, file);
      const existing = await this.get(id);
      if (existing) {
        await this.update(id, { openedAt: Date.now() });
        return Object.assign(existing, { openedAt: Date.now() });
      }
      const meta = {
        id, title: book.title, authors: book.authors, format: book.format, formatLabel: book.formatLabel,
        name: file.name, size: buf.byteLength, addedAt: Date.now(), openedAt: Date.now(),
        pos: 0, segCount: 0, progress: 0, cover: await thumbnail(book.cover),
      };
      const d = await db();
      await new Promise((res, rej) => {
        const tx = d.transaction(["library", "files"], "readwrite");
        tx.objectStore("files").put({ name: file.name, type: file.type || "", data: buf }, id);
        tx.objectStore("library").put(meta);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error || new Error("Не хватает места в хранилище браузера"));
      });
      return meta;
    },
    // аудиокнига: файл хранится как Blob (сотни мегабайт в память не читаются); номер — по размеру и кускам файла
    // id — номер из каталога сервера (SHA-256 файла, как у приложения): книга из каталога узнаётся как уже скачанная
    async addAudio(blob, name, book, cover, id) {
      id = id || await audioId(blob, name);
      const existing = await this.get(id);
      if (existing) {
        await this.update(id, { openedAt: Date.now() });
        return Object.assign(existing, { openedAt: Date.now() });
      }
      const meta = audioMeta(id, name, blob.size, book, cover);
      const d = await db();
      await new Promise((res, rej) => {
        const tx = d.transaction(["library", "files"], "readwrite");
        tx.objectStore("files").put({ name, type: blob.type || "", data: blob }, id);
        tx.objectStore("library").put(meta);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error || new Error("Не хватает места в хранилище браузера"));
      });
      return meta;
    },
    // файл книги как Blob (для аудиокниг — без чтения в память)
    async blob(id) {
      const rec = await this.getFile(id);
      if (!rec) return null;
      return rec.data instanceof Blob ? rec.data : new Blob([rec.data], { type: rec.type || "" });
    },
    async reader(id) {
      const b = await this.blob(id);
      return b ? AudioMeta.blobReader(b) : null;
    },
    async remove(id) {
      const d = await db();
      return new Promise((res, rej) => {
        const tx = d.transaction(["library", "files"], "readwrite");
        tx.objectStore("library").delete(id);
        tx.objectStore("files").delete(id);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    },
    async clear() {
      const d = await db();
      return new Promise((res, rej) => {
        const tx = d.transaction(["library", "files"], "readwrite");
        tx.objectStore("library").clear();
        tx.objectStore("files").clear();
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    },
    async estimate() {
      try {
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
        return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      } catch (_) { return null; }
    },
    // перенос «последней книги» из первой версии читалки
    async migrateOld(parse) {
      try {
        const rec = await req("books", "readonly", (s) => s.get("last"));
        if (!rec || !rec.data) return null;
        const file = new File([rec.data], rec.name);
        const book = await parse(file);
        const meta = await this.add(file, rec.data, book);
        await req("books", "readwrite", (s) => s.delete("last"));
        return meta;
      } catch (_) { return null; }
    },
  };

  window.Library = Library;
})();
