/**
 * Zip the extension with no dependencies (node:zlib deflate + a hand-written ZIP container).
 *   node packages/extension/scripts/zip.mjs [outFile]      default: packages/extension/dist/complir-extension.zip
 * Regenerates the icons first. Pass e.g. public/downloads/complir-extension.zip to publish it from the Next app.
 */
import { deflateRawSync, crc32 } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
execFileSync(process.execPath, [join(here, "icons.mjs")], { stdio: "inherit" });

const INCLUDE = ["manifest.json", "background.js", "content.js", "popup.html", "popup.js", "README.md", "lib", "icons"];
function walk(p, acc) {
  const st = statSync(p);
  if (st.isDirectory()) for (const f of readdirSync(p).sort()) walk(join(p, f), acc); else acc.push(p);
  return acc;
}
const files = INCLUDE.flatMap((f) => walk(join(root, f), [])).map((abs) => ({ name: relative(root, abs).split("\\").join("/"), data: readFileSync(abs) }));

function dosTime(d) { return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff; }
function dosDate(d) { return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff; }
const now = new Date();
const locals = [], centrals = [];
let offset = 0;
for (const f of files) {
  const name = Buffer.from(f.name, "utf8");
  const comp = deflateRawSync(f.data, { level: 9 });
  const useDeflate = comp.length < f.data.length;
  const body = useDeflate ? comp : f.data;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(f.data) >>> 0;
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(dosTime(now), 10); lh.writeUInt16LE(dosDate(now), 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
  ch.writeUInt16LE(dosTime(now), 12); ch.writeUInt16LE(dosDate(now), 14); ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28);
  ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
  locals.push(lh, name, body); centrals.push(ch, name);
  offset += lh.length + name.length + body.length;
}
const cd = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
const zip = Buffer.concat([...locals, cd, eocd]);

const outFile = resolve(process.argv[2] ?? join(root, "dist", "complir-extension.zip"));
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, zip);
console.log(`${relative(process.cwd(), outFile)}  ${files.length} files  ${zip.length} bytes`);
