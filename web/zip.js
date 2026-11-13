// Минимальный ZIP-читатель (для FB2.ZIP, EPUB, DOCX, ODT). Распаковка через DecompressionStream.
(function () {
  "use strict";
  const u16 = (v, o) => v.getUint16(o, true);
  const u32 = (v, o) => v.getUint32(o, true);

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") throw new Error("Браузер не умеет распаковывать ZIP");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function isZip(buf) {
    const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    return b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;
  }

  function open(buf) {
    const v = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
      if (u32(v, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Повреждённый ZIP-архив");
    const count = u16(v, eocd + 10);
    let p = u32(v, eocd + 16);
    const utf8 = new TextDecoder("utf-8");
    const entries = new Map();
    for (let n = 0; n < count; n++) {
      if (u32(v, p) !== 0x02014b50) break;
      const method = u16(v, p + 10);
      const csize = u32(v, p + 20);
      const nlen = u16(v, p + 28), elen = u16(v, p + 30), clen = u16(v, p + 32);
      const off = u32(v, p + 42);
      const name = utf8.decode(new Uint8Array(buf, p + 46, nlen));
      if (!name.endsWith("/")) entries.set(name, { name, method, csize, off });
      p += 46 + nlen + elen + clen;
    }
    const lower = new Map([...entries.keys()].map((k) => [k.toLowerCase(), k]));
    const find = (name) => entries.get(name) || entries.get(lower.get(String(name).toLowerCase()));

    async function bytes(name) {
      const e = find(name);
      if (!e) return null;
      const lnlen = u16(v, e.off + 26), lelen = u16(v, e.off + 28);
      const data = new Uint8Array(buf, e.off + 30 + lnlen + lelen, e.csize);
      if (e.method === 0) return data.slice();
      if (e.method === 8) return inflateRaw(data);
      throw new Error("Неподдерживаемое сжатие в ZIP");
    }
    async function text(name) {
      const b = await bytes(name);
      return b ? new TextDecoder("utf-8").decode(b) : null;
    }
    return { names: [...entries.keys()], has: (n) => !!find(n), bytes, text };
  }

  // путь относительно файла: resolve("OEBPS/text/ch1.xhtml", "../img/a.jpg") → "OEBPS/img/a.jpg"
  function resolve(base, rel) {
    rel = decodeURIComponent(rel.split("#")[0]);
    if (!rel) return base;
    if (rel.startsWith("/")) return rel.slice(1);
    const parts = base.split("/").slice(0, -1);
    for (const seg of rel.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== "." && seg !== "") parts.push(seg);
    }
    return parts.join("/");
  }

  // ---------- запись: простой ZIP без сжатия (несколько файлов книги → один файл в библиотеке) ----------
  let crcTable = null;
  function crc32(u8) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    }
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  // files: [{ name, data: Uint8Array }] → Uint8Array (имена в UTF-8)
  function build(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = f.data, crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((a, x) => a + x.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
    const all = [...parts, ...central, new Uint8Array(e.buffer)];
    const out = new Uint8Array(all.reduce((a, x) => a + x.length, 0));
    let p = 0;
    for (const x of all) { out.set(x, p); p += x.length; }
    return out;
  }

  window.Zip = { isZip, open, resolve, build };
})();
