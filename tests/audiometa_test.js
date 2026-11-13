// Проверка разбора аудиокниг (web/audiometa.js). Тестовые файлы создаёт ffmpeg во временной папке.
// Запуск: node tests/audiometa_test.js   (без ffmpeg — пропускается)
const { execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const A = require("../web/audiometa.js");

try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch (_) { console.log("ffmpeg не найден — пропуск"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abtest-"));
const ff = (...args) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args], { cwd: dir });
const P = (n) => path.join(dir, n);
let fails = 0;
const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const near = (a, b, d = 0.15) => Math.abs(a - b) <= d;

fs.writeFileSync(P("ch.txt"), `;FFMETADATA1
title=Тестовая книга
artist=Иван Автор
album=Тестовая книга (альбом)
[CHAPTER]
TIMEBASE=1/1000
START=0
END=4000
title=Глава первая
[CHAPTER]
TIMEBASE=1/1000
START=4000
END=10000
title=Глава вторая
`);
const sine = (d) => ["-f", "lavfi", "-i", `sine=f=440:d=${d}`];
ff("-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", "cover.jpg");
const meta = ["-map_metadata", "1", "-map_chapters", "1"];
ff(...sine(10), "-i", "ch.txt", "-i", "cover.jpg", "-map", "0", "-map", "2", ...meta, "-c:a", "libmp3lame", "-b:a", "64k", "-c:v", "copy", "-id3v2_version", "3", "-disposition:v", "attached_pic", "book.mp3");
ff(...sine(10), "-i", "ch.txt", ...meta, "-c:a", "libmp3lame", "-b:a", "64k", "book24.mp3");          // ID3v2.4
ff(...sine(10), "-i", "ch.txt", "-i", "cover.jpg", "-map", "0", "-map", "2", ...meta, "-c:a", "aac", "-c:v", "copy", "-disposition:v", "attached_pic", "book.m4b");
ff(...sine(10), "-i", "ch.txt", ...meta, "-c:a", "libopus", "book.opus");
ff(...sine(10), "-i", "ch.txt", ...meta, "-c:a", "libvorbis", "book.ogg");
ff(...sine(10), "-i", "ch.txt", "-i", "cover.jpg", "-map", "0", "-map", "2", ...meta, "-c:a", "flac", "-c:v", "copy", "-disposition:v", "attached_pic", "book.flac");
ff(...sine(10), "-map_metadata", "-1", "book.wav");
ff(...sine(7), "-c:a", "libmp3lame", "-b:a", "96k", "-write_xing", "0", "-map_metadata", "-1", "notag.mp3");
for (const i of [1, 2, 10]) ff(...sine(3), "-metadata", `title=Часть ${i}`, "-metadata", "artist=Пётр Чтец", "-metadata", "album=Сборник рассказов", "-c:a", "libmp3lame", "-b:a", "32k", `Рассказы_${i}.mp3`);

// ID3v1 в cp1251 (старые русские MP3)
{
  const t = Buffer.alloc(128);
  t.write("TAG", 0, "latin1");
  const cp = (s) => Buffer.from([...s].map((c) => { const k = c.charCodeAt(0); return k >= 0x410 && k <= 0x44f ? k - 0x410 + 0xc0 : k; }));
  cp("Глава один").copy(t, 3); cp("Автор Авторов").copy(t, 33); cp("Книга").copy(t, 63);
  fs.writeFileSync(P("v1.mp3"), Buffer.concat([fs.readFileSync(P("notag.mp3")), t]));
}

// ZIP без сжатия (и со сжатием — ошибка)
function zip(name, files, method = 0) {
  const zlib = require("zlib");
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const loc = [], cen = [];
  let off = 0;
  for (const [n, data] of files) {
    const nb = Buffer.from(n, "utf8"), body = method ? zlib.deflateRawSync(data) : data;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(method, 8);
    h.writeUInt32LE(crc(data), 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nb.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc(data), 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    loc.push(h, nb, body); cen.push(c, nb);
    off += 30 + nb.length + body.length;
  }
  const cd = Buffer.concat(cen), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  fs.writeFileSync(P(name), Buffer.concat([...loc, cd, e]));
}
const rd = (n) => fs.readFileSync(P(n));
zip("parts.zip", [["Сборник/Рассказы_10.mp3", rd("Рассказы_10.mp3")], ["Сборник/Рассказы_2.mp3", rd("Рассказы_2.mp3")], ["Сборник/Рассказы_1.mp3", rd("Рассказы_1.mp3")], ["Сборник/cover.jpg", rd("cover.jpg")]]);
zip("deflated.zip", [["a.mp3", rd("Рассказы_1.mp3")]], 8);
fs.writeFileSync(P("broken.mp3"), Buffer.alloc(5000));
fs.writeFileSync(P("trunc.m4b"), rd("book.m4b").subarray(0, 30000));

const reader = (n) => A.bytesReader(new Uint8Array(rd(n)));
const CH = JSON.stringify([{ title: "Глава первая", start: 0 }, { title: "Глава вторая", start: 4 }]);

(async () => {
  for (const [f, fmt, cover, chapters] of [["book.mp3", "mp3", true, true], ["book24.mp3", "mp3", false, true], ["book.m4b", "mp4", true, true],
    ["book.opus", "ogg", false, true], ["book.ogg", "ogg", false, false], ["book.flac", "flac", true, false]]) {
    const m = await A.readFile(reader(f), f);
    ok(m.format === fmt && m.title === "Тестовая книга" && m.artist === "Иван Автор" && m.album === "Тестовая книга (альбом)", `${f}: теги`);
    ok(near(m.duration, 10), `${f}: длительность ${m.duration.toFixed(2)}`);
    ok(!!m.cover === cover, `${f}: обложка ${cover ? "есть" : "нет"}`);
    if (chapters) ok(JSON.stringify(m.chapters) === CH, `${f}: главы`);
  }
  // M4B: главы QuickTime и Nero — каждые по отдельности
  for (const atom of ["chpl", "chap"]) {
    const b = Buffer.from(rd("book.m4b"));
    b.write("xxxx", b.indexOf(atom));
    const m = await A.readFile(A.bytesReader(new Uint8Array(b)), "a.m4b");
    ok(JSON.stringify(m.chapters) === CH, `M4B без ${atom}: главы из другого источника`);
  }
  let m = await A.readFile(reader("book.wav"), "book.wav");
  ok(m.format === "wav" && near(m.duration, 10), "WAV: длительность");
  m = await A.readFile(reader("notag.mp3"), "notag.mp3");
  ok(m.title === "" && near(m.duration, 7), "MP3 без тегов и Xing: длительность по битрейту");
  m = await A.readBook(reader("v1.mp3"), "v1.mp3");
  ok(m.title === "Книга" && m.authors[0] === "Автор Авторов" && m.chapters[0].title === "Глава один", "ID3v1 в cp1251");
  m = await A.readBook(reader("notag.mp3"), "Моя книга_01.mp3");
  ok(m.title === "Моя книга 01" && m.chapters.length === 1, "без тегов — название из имени файла");

  m = await A.readBook(reader("parts.zip"), "parts.zip");
  ok(m.title === "Сборник рассказов" && m.authors[0] === "Пётр Чтец", "ZIP: название и автор из тегов");
  ok(m.parts.map((p) => p.name.split("/")[1]).join() === "Рассказы_1.mp3,Рассказы_2.mp3,Рассказы_10.mp3", "ZIP: части по именам «по-человечески»");
  ok(m.chapters.map((c) => c.title).join() === "Часть 1,Часть 2,Часть 10" && near(m.chapters[2].at, 6.06), "ZIP: главы = части, время от начала книги");
  ok(near(m.duration, 9.09) && !!m.cover, "ZIP: общая длительность, обложка из cover.jpg");
  const zbuf = rd("parts.zip");
  ok(m.parts.every((p) => zbuf.subarray(p.off, p.off + 3).toString("latin1") === "ID3"), "ZIP: смещения частей указывают на начало файлов");

  for (const [f, re] of [["deflated.zip", /сжаты/], ["broken.mp3", /не похоже/], ["trunc.m4b", /moov/]]) {
    let err = "";
    try { await A.readBook(reader(f), f); } catch (e) { err = e.message; }
    ok(re.test(err), `${f}: понятная ошибка («${err}»)`);
  }
  // сборка: отдельные файлы + сжатый архив → один ZIP без сжатия (CRC проверяет Python)
  {
    const { File } = require("buffer");
    const files = [new File([rd("Рассказы_2.mp3")], "Рассказы_2.mp3"), new File([rd("Рассказы_1.mp3")], "Рассказы_1.mp3"), new File([rd("deflated.zip")], "zz.zip")];
    let last = 0;
    const parts = await A.collectParts(files);
    const blob = await A.packZip(parts, (f) => { last = f; });
    const u8 = new Uint8Array(await blob.arrayBuffer());
    fs.writeFileSync(P("packed.zip"), u8);
    const t = execFileSync("python3", ["-c", "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip(), [i.compress_type for i in z.infolist()], [i.filename for i in z.infolist()])", P("packed.zip")]).toString().trim();
    ok(t.startsWith("None [0, 0, 0]") && t.includes("'Рассказы_1.mp3', 'Рассказы_2.mp3', 'a.mp3'"), "сборка: ZIP без сжатия, CRC верны, порядок частей (" + t + ")");
    ok(Math.abs(last - 1) < 1e-9, "сборка: прогресс доходит до 100%");
    const m2 = await A.readBook(A.bytesReader(u8), A.packName(parts.map((p) => p.name)));
    ok(m2.parts.length === 3 && near(m2.duration, 9.09), "сборка: книга из трёх частей читается");
    ok(await A.zipIsAudio(A.bytesReader(u8)) && !(await A.zipNeedsRepack(A.bytesReader(u8))) && await A.zipNeedsRepack(reader("deflated.zip")), "распознавание: аудио-ZIP, нужна ли пересборка");
    ok(A.packName(["Книга - 01.mp3", "Книга - 02.mp3"]) === "Книга.zip", "имя собранной книги");
  }
  ok(A.fmtTime(3725) === "1:02:05" && A.fmtTime(65) === "1:05" && A.fmtDuration(5400) === "1 ч 30 мин", "форматы времени");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? `ОШИБОК: ${fails}` : "всё в порядке");
  process.exit(fails ? 1 : 0);
})();
