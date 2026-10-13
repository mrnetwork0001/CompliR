/**
 * Generate icons/icon{16,48,128}.png with no dependencies: raw PNG (RGBA, filter 0) via node:zlib.
 * Motif: dark 2px-radius tile, cyan accent ring + 8-cell pixel bar (CompliR "meter").  node packages/extension/scripts/icons.mjs
 */
import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "icons");
mkdirSync(out, { recursive: true });

const BG = [0x0f, 0x11, 0x14, 255], ACC = [0x3f, 0xe0, 0xc8, 255], INK = [0xec, 0xed, 0xee, 255], FAINT = [0x60, 0x65, 0x6d, 255], NONE = [0, 0, 0, 0];

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Tile with a thin accent ring near the edge and an 8-cell meter across the lower third (cells 1-6 lit). */
function art(size) {
  const r = Math.max(1, Math.round(size / 8)); // corner radius ~ 2px at 16
  const ring = Math.max(1, Math.round(size / 16));
  const cells = 8, gap = Math.max(1, Math.round(size / 24));
  const barW = size - 2 * Math.round(size * 0.2), cellW = Math.floor((barW - gap * (cells - 1)) / cells);
  const x0 = Math.round((size - (cellW * cells + gap * (cells - 1))) / 2);
  const barY = Math.round(size * 0.62), barH = Math.max(1, Math.round(size * 0.14));
  const dotR = Math.max(1, Math.round(size * 0.07)), dotX = Math.round(size * 0.3), dotY = Math.round(size * 0.36);
  return (x, y) => {
    const inside = (px, py, inset) => {
      const cx = Math.min(Math.max(px, inset + r), size - 1 - inset - r), cy = Math.min(Math.max(py, inset + r), size - 1 - inset - r);
      return px >= inset && py >= inset && px < size - inset && py < size - inset && (px - cx) ** 2 + (py - cy) ** 2 <= r * r + r;
    };
    if (!inside(x, y, 0)) return NONE;
    if (!inside(x, y, ring) ) return ACC; // outer accent ring
    if (y >= barY && y < barY + barH) {
      const rel = x - x0;
      if (rel >= 0) { const i = Math.floor(rel / (cellW + gap)); if (i < cells && rel % (cellW + gap) < cellW) return i < 6 ? ACC : FAINT; }
    }
    if ((x - dotX) ** 2 + (y - dotY) ** 2 <= dotR * dotR + 0.5) return INK; // live dot
    return BG;
  };
}
for (const s of [16, 48, 128]) { writeFileSync(join(out, `icon${s}.png`), png(s, art(s))); console.log(`icons/icon${s}.png`); }
