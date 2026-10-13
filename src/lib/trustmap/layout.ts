/**
 * Radial Trust Map layout, no external libs. Tier bands are concentric rings around the chain readout:
 * HIGH innermost, then MEDIUM, LOW, and observed-but-ungraded candidates on the outermost ring. A node's angle is a
 * stable hash of its address (refreshes only move what changed); neighbours on a ring are pushed apart along the ring
 * so marks never overlap, and a crowded ring splits into up to 5 lanes (±11 px radius steps). Same input → same output.
 */
import type { Address, Tier } from "../types";
import type { MapCandidate, MapEdge, MapNode } from "./types";

export type Band = Tier | "OBSERVED";

export interface Placed {
  address: Address;
  band: Band;
  /** tier for graded nodes; null for candidates */
  tier: Tier | null;
  x: number;
  y: number;
  /** outer mark radius (ring); spacing + hit area */
  r: number;
  /** filled core radius ∝ log(USDC in 24 h) */
  core: number;
  /** angle on the ring, radians */
  angle: number;
  /** ring radius after lane offset */
  radius: number;
}
export interface Ring {
  band: Band;
  radius: number;
  count: number;
}
export interface LayoutResult {
  width: number;
  height: number;
  cx: number;
  cy: number;
  nodes: Placed[];
  rings: Ring[];
  byAddress: Map<string, Placed>;
}

export const LAYOUT_W = 1200;
export const LAYOUT_H = 780;
export const RING_RADIUS: Record<Band, number> = { HIGH: 96, MEDIUM: 176, LOW: 256, OBSERVED: 326 };
export const BANDS: Band[] = ["HIGH", "MEDIUM", "LOW", "OBSERVED"];
/** ring labels sit at 12 o'clock; this angular slot around it stays free of marks */
export const LABEL_ANGLE = -Math.PI / 2;
const LABEL_GAP = 0.1;
const LANE_STEP = 11;

/** filled core radius for a graded node */
export function coreRadius(usdcIn24h: number): number {
  const r = 2.2 + 1.6 * Math.log10(1 + Math.max(0, usdcIn24h));
  return Math.round(Math.min(9, Math.max(2.2, r)) * 100) / 100;
}
/** filled core radius for an observed candidate (smaller scale) */
export function candidateCoreRadius(usdcIn24h: number): number {
  const r = 1.2 + 0.9 * Math.log10(1 + Math.max(0, usdcIn24h));
  return Math.round(Math.min(4.5, Math.max(1.2, r)) * 100) / 100;
}
/** gap between core and ring: the mark reads as an instrument ring, not a disc */
export const RING_PAD = 6;
export const CANDIDATE_RING_PAD = 3;
/** outer mark radius (back-compat name) */
export function nodeRadius(usdcIn24h: number): number {
  return coreRadius(usdcIn24h) + RING_PAD;
}

/** FNV-1a over the lowercase address → stable angle in (LABEL_ANGLE + LABEL_GAP, LABEL_ANGLE + 2π − LABEL_GAP) */
export function hashAngle(address: string): number {
  let h = 0x811c9dc5;
  const s = address.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const u = h / 4294967296;
  return LABEL_ANGLE + LABEL_GAP + u * (Math.PI * 2 - 2 * LABEL_GAP);
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const TAU = Math.PI * 2;

interface Seed {
  address: Address;
  band: Band;
  tier: Tier | null;
  core: number;
  r: number;
  angle: number;
  radius: number;
}

/**
 * Spread one lane's marks along the ring. Pass 1 relaxes pairs both ways (marks stay near their hash angle);
 * pass 2 walks the lane once and enforces every gap, compressing uniformly when the lane is fuller than the ring.
 * Lanes are independent (their radial step is one full mark slot), so same-lane spacing is all that is needed.
 */
function spreadLane(items: Seed[], radius: number, passes: number): void {
  if (items.length < 2) return;
  const lo = LABEL_ANGLE + LABEL_GAP, hi = LABEL_ANGLE + TAU - LABEL_GAP;
  const need = (a: Seed, b: Seed) => (a.r + b.r + 4) / radius;
  items.sort((a, b) => a.angle - b.angle || a.address.localeCompare(b.address));
  for (let p = 0; p < passes; p++) {
    let moved = false;
    for (let i = 0; i < items.length - 1; i++) {
      const a = items[i], b = items[i + 1];
      const gap = b.angle - a.angle, min = need(a, b);
      if (gap >= min) continue;
      const push = (min - gap) / 2;
      a.angle = Math.max(lo, a.angle - push);
      b.angle = Math.min(hi, b.angle + push);
      moved = true;
    }
    if (!moved) return;
  }
  // guarantee: forward pass, compressed to the ring when the lane is overfull
  let total = 0;
  for (let i = 1; i < items.length; i++) total += need(items[i - 1], items[i]);
  const k = Math.min(1, (hi - lo) / total);
  items[0].angle = Math.max(lo, Math.min(items[0].angle, hi - total * k));
  for (let i = 1; i < items.length; i++) items[i].angle = Math.max(items[i].angle, items[i - 1].angle + need(items[i - 1], items[i]) * k);
  const over = items[items.length - 1].angle - hi;
  if (over > 0) for (const it of items) it.angle = Math.max(lo, it.angle - over);
}
const MAX_LANES = 5;
/** total radial room a ring may spread its lanes over (±26 px keeps neighbouring rings apart) */
const LANE_SLACK = 52;

export function layoutMap(nodes: MapNode[], edges: MapEdge[], opts: { width?: number; height?: number; candidates?: MapCandidate[]; passes?: number } = {}): LayoutResult {
  void edges; // edges do not move marks on a ring layout; kept in the signature for callers
  const W = opts.width ?? LAYOUT_W;
  const H = opts.height ?? LAYOUT_H;
  const cx = W / 2, cy = H / 2;
  const passes = opts.passes ?? 40;
  const byBand: Record<Band, Seed[]> = { HIGH: [], MEDIUM: [], LOW: [], OBSERVED: [] };
  for (const n of nodes) {
    const core = coreRadius(n.usdcIn24h);
    (byBand[n.tier] ?? byBand.MEDIUM).push({ address: n.address, band: n.tier, tier: n.tier, core, r: core + RING_PAD, angle: hashAngle(n.address), radius: RING_RADIUS[n.tier] ?? RING_RADIUS.MEDIUM });
  }
  for (const c of opts.candidates ?? []) {
    const core = candidateCoreRadius(c.usdcIn24h);
    byBand.OBSERVED.push({ address: c.address, band: "OBSERVED", tier: null, core, r: core + CANDIDATE_RING_PAD, angle: hashAngle(c.address), radius: RING_RADIUS.OBSERVED });
  }

  const placed: Placed[] = [];
  const rings: Ring[] = [];
  for (const band of BANDS) {
    const R = RING_RADIUS[band];
    const list = byBand[band];
    rings.push({ band, radius: R, count: list.length });
    if (!list.length) continue;
    // lanes: the step is one full slot of the biggest mark (lanes never collide); still overfull → marks shrink to fit
    const span = TAU - 2 * LABEL_GAP;
    let lanes = 1, step = LANE_STEP;
    for (let iter = 0; iter < 4; iter++) {
      const slot = 2 * Math.max(...list.map((it) => it.r)) + 4;
      const perLane = (span * R) / (2 * (list.reduce((s, it) => s + it.r, 0) / list.length) + 4);
      const lanesMax = Math.max(1, Math.min(MAX_LANES, 1 + Math.floor(LANE_SLACK / slot)));
      lanes = Math.max(1, Math.min(lanesMax, Math.ceil(list.length / perLane)));
      step = Math.max(LANE_STEP, slot);
      if (list.length <= lanes * perLane) break;
      const k = Math.max(0.4, ((lanes * perLane) / list.length) * 0.97);
      for (const it of list) { it.core = r2(Math.max(1.2, it.core * k)); it.r = r2(Math.max(3, it.r * k)); }
    }
    list.sort((a, b) => a.angle - b.angle || a.address.localeCompare(b.address));
    list.forEach((it, i) => { it.radius = r2(R + ((i % lanes) - (lanes - 1) / 2) * step); });
    for (let lane = 0; lane < lanes; lane++) {
      const mine = list.filter((_, i) => i % lanes === lane);
      spreadLane(mine, mine[0]?.radius ?? R, passes);
    }
    for (const it of list) {
      placed.push({
        address: it.address, band, tier: it.tier, r: it.r, core: it.core, angle: r2(it.angle), radius: r2(it.radius),
        x: r2(cx + Math.cos(it.angle) * it.radius), y: r2(cy + Math.sin(it.angle) * it.radius),
      });
    }
  }
  return { width: W, height: H, cx, cy, nodes: placed, rings, byAddress: new Map(placed.map((p) => [p.address, p])) };
}
