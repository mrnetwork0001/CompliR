/**
 * Minimal QR code encoder (ISO/IEC 18004): byte mode, versions 1–10, error-correction level M, automatic mask selection.
 * No dependencies. Used by /pay to render an EIP-681 payment URI as inline SVG. Returns a boolean matrix.
 */

export type QrMatrix = boolean[][];

// ── tables (versions 1–10, level M) ──────────────────────────────────────────
// [total data codewords, EC codewords per block, blocks in group 1, data cw per block g1, blocks in group 2, data cw per block g2]
const EC_M: [number, number, number, number, number, number][] = [
  [16, 10, 1, 16, 0, 0],   // v1
  [28, 16, 1, 28, 0, 0],   // v2
  [44, 26, 1, 44, 0, 0],   // v3
  [64, 18, 2, 32, 0, 0],   // v4
  [86, 24, 2, 43, 0, 0],   // v5
  [108, 16, 4, 27, 0, 0],  // v6
  [124, 18, 4, 31, 0, 0],  // v7
  [154, 22, 2, 38, 2, 39], // v8
  [182, 22, 3, 36, 2, 37], // v9
  [216, 26, 4, 43, 1, 44], // v10
];
const ALIGN: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
/** version information bits (versions 7..10), BCH(18,6) */
const VERSION_INFO: Record<number, number> = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

// ── GF(256) with 0x11d ───────────────────────────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generatorPoly(n: number): number[] {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
    g = next;
  }
  return g;
}
function rsEncode(data: number[], ecLen: number): number[] {
  const g = generatorPoly(ecLen);
  const rem = new Array(ecLen).fill(0);
  for (const d of data) {
    const f = d ^ rem[0];
    rem.shift(); rem.push(0);
    if (f !== 0) for (let j = 0; j < ecLen; j++) rem[j] ^= mul(g[j + 1], f);
  }
  return rem;
}

// ── bit buffer ───────────────────────────────────────────────────────────────
class Bits {
  bits: number[] = [];
  put(v: number, n: number) { for (let i = n - 1; i >= 0; i--) this.bits.push((v >>> i) & 1); }
  get length() { return this.bits.length; }
}

function chooseVersion(byteLen: number): number {
  for (let v = 1; v <= 10; v++) {
    const cap = EC_M[v - 1][0] * 8;
    const header = 4 + (v <= 9 ? 8 : 16);
    if (header + byteLen * 8 <= cap) return v;
  }
  throw new Error(`QR: payload too long (${byteLen} bytes; max for version 10-M is 213)`);
}

function buildCodewords(bytes: Uint8Array, version: number): number[] {
  const [total, ecPer, g1n, g1len, g2n, g2len] = EC_M[version - 1];
  const b = new Bits();
  b.put(0b0100, 4);
  b.put(bytes.length, version <= 9 ? 8 : 16);
  for (const x of bytes) b.put(x, 8);
  const cap = total * 8;
  b.put(0, Math.min(4, cap - b.length));
  while (b.length % 8 !== 0) b.put(0, 1);
  const data: number[] = [];
  for (let i = 0; i < b.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | b.bits[i + j]; data.push(v); }
  for (let pad = 0xec; data.length < total; pad ^= 0xec ^ 0x11) data.push(pad);

  const blocks: number[][] = []; const ecs: number[][] = [];
  let off = 0;
  for (let i = 0; i < g1n; i++) { const d = data.slice(off, off + g1len); off += g1len; blocks.push(d); ecs.push(rsEncode(d, ecPer)); }
  for (let i = 0; i < g2n; i++) { const d = data.slice(off, off + g2len); off += g2len; blocks.push(d); ecs.push(rsEncode(d, ecPer)); }
  const out: number[] = [];
  const maxLen = Math.max(g1len, g2len);
  for (let i = 0; i < maxLen; i++) for (const bl of blocks) if (i < bl.length) out.push(bl[i]);
  for (let i = 0; i < ecPer; i++) for (const e of ecs) out.push(e[i]);
  return out;
}

// ── matrix ───────────────────────────────────────────────────────────────────
function makeMatrix(version: number, codewords: number[]): { grid: QrMatrix; reserved: boolean[][] } {
  const size = version * 4 + 17;
  const grid: QrMatrix = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r: number, c: number, v: boolean) => { grid[r][c] = v; reserved[r][c] = true; };

  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const on = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(rr, cc, on);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  const al = ALIGN[version - 1];
  for (const r of al) for (const c of al) {
    if (reserved[r][c]) continue; // overlaps a finder
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  for (let i = 8; i < size - 8; i++) { if (!reserved[6][i]) set(6, i, i % 2 === 0); if (!reserved[i][6]) set(i, 6, i % 2 === 0); }
  set(size - 8, 8, true); // dark module
  // format info areas
  for (let i = 0; i < 9; i++) { if (!reserved[8][i]) reserved[8][i] = true; if (!reserved[i][8]) reserved[i][8] = true; }
  for (let i = 0; i < 8; i++) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }
  if (version >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { reserved[i][size - 11 + j] = true; reserved[size - 11 + j][i] = true; }

  // data placement
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  let bi = 0; let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < size; k++) {
      const row = upward ? size - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        grid[row][c] = bi < bits.length ? bits[bi] === 1 : false;
        bi++;
      }
    }
    upward = !upward;
  }
  return { grid, reserved };
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function bch15(data: number): number {
  let d = data << 10;
  for (let i = 14; i >= 10; i--) if ((d >>> i) & 1) d ^= 0x537 << (i - 10);
  return ((data << 10) | d) ^ 0x5412;
}

function writeFormat(grid: QrMatrix, mask: number): void {
  const size = grid.length;
  const bits = bch15((0b00 << 3) | mask); // level M = 00
  for (let i = 0; i < 15; i++) {
    const v = ((bits >>> (14 - i)) & 1) === 1; // bit 0 = MSB
    // around top-left
    if (i < 6) grid[8][i] = v; else if (i < 8) grid[8][i + 1] = v; else if (i === 8) grid[7][8] = v; else grid[14 - i][8] = v;
    // split copy: 7 bits up the left column (above the dark module), 8 bits along the top-right row
    if (i < 7) grid[size - 1 - i][8] = v; else grid[8][size - 15 + i] = v;
  }
}
function writeVersion(grid: QrMatrix, version: number): void {
  if (version < 7) return;
  const size = grid.length; const bits = VERSION_INFO[version];
  for (let i = 0; i < 18; i++) {
    const v = ((bits >>> i) & 1) === 1;
    const a = Math.floor(i / 3), b = i % 3;
    grid[a][size - 11 + b] = v; grid[size - 11 + b][a] = v;
  }
}

function penalty(g: QrMatrix): number {
  const n = g.length; let p = 0;
  const run = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < n; i++) { let cnt = 1; for (let j = 1; j < n; j++) { if (get(i, j) === get(i, j - 1)) { cnt++; if (cnt === 5) p += 3; else if (cnt > 5) p++; } else cnt = 1; } }
  };
  run((i, j) => g[i][j]); run((i, j) => g[j][i]);
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) { const v = g[r][c]; if (v === g[r][c + 1] && v === g[r + 1][c] && v === g[r + 1][c + 1]) p += 3; }
  const pat = [true, false, true, true, true, false, true];
  const finderLike = (get: (k: number) => boolean | undefined, start: number) => {
    for (let k = 0; k < 7; k++) if (get(start + k) !== pat[k]) return false;
    let left = true, right = true;
    for (let k = 1; k <= 4; k++) { if (get(start - k) !== false) left = false; if (get(start + 6 + k) !== false) right = false; }
    return left || right;
  };
  for (let i = 0; i < n; i++) for (let j = 0; j <= n - 7; j++) {
    if (finderLike((k) => (k >= 0 && k < n ? g[i][k] : undefined), j)) p += 40;
    if (finderLike((k) => (k >= 0 && k < n ? g[k][i] : undefined), j)) p += 40;
  }
  let dark = 0; for (const row of g) for (const v of row) if (v) dark++;
  const pct = (dark * 100) / (n * n);
  const prev = Math.floor(pct / 5) * 5, next = prev + 5;
  p += Math.min(Math.abs(prev - 50) / 5, Math.abs(next - 50) / 5) * 10;
  return p;
}

export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const cws = buildCodewords(bytes, version);
  const { grid, reserved } = makeMatrix(version, cws);
  let best: QrMatrix | null = null; let bestP = Infinity;
  for (let m = 0; m < 8; m++) {
    const g = grid.map((row) => row.slice());
    for (let r = 0; r < g.length; r++) for (let c = 0; c < g.length; c++) if (!reserved[r][c] && MASKS[m](r, c)) g[r][c] = !g[r][c];
    writeFormat(g, m); writeVersion(g, version);
    const p = penalty(g);
    if (p < bestP) { bestP = p; best = g; }
  }
  return best!;
}

/** SVG path (one `M…h1v1h-1z` per dark module is bulky; we draw horizontal runs) with `quiet` modules of margin. */
export function qrSvgPath(m: QrMatrix, quiet = 2): { path: string; size: number } {
  const parts: string[] = [];
  for (let r = 0; r < m.length; r++) {
    let c = 0;
    while (c < m.length) {
      if (!m[r][c]) { c++; continue; }
      let w = 1; while (c + w < m.length && m[r][c + w]) w++;
      parts.push(`M${c + quiet} ${r + quiet}h${w}v1h-${w}z`);
      c += w;
    }
  }
  return { path: parts.join(""), size: m.length + quiet * 2 };
}
