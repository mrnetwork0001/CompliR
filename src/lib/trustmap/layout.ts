/**
 * Deterministic "force-directed-ish" layout, no external libs. Three tier clusters (HIGH centre-left, MEDIUM
 * upper-right, LOW lower-right); inside a cluster nodes sit on a phyllotaxis spiral (biggest USDC inflow at
 * the centre), then a fixed number of relaxation passes resolve overlaps, pull nodes gently toward their
 * cluster centre and nudge connected nodes together. Same input → same output, so refreshes only move what changed.
 */
import type { Tier } from "../types";
import type { MapEdge, MapNode } from "./types";

export interface Placed {
  address: MapNode["address"];
  tier: Tier;
  x: number;
  y: number;
  r: number;
}
export interface Cluster {
  tier: Tier;
  cx: number;
  cy: number;
  count: number;
  /** radius that encloses the cluster's nodes (+ padding) */
  radius: number;
}
export interface LayoutResult {
  width: number;
  height: number;
  nodes: Placed[];
  clusters: Cluster[];
  byAddress: Map<string, Placed>;
}

export const LAYOUT_W = 1200;
export const LAYOUT_H = 640;
const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.39996 rad

export function nodeRadius(usdcIn24h: number): number {
  const r = 7 + 5 * Math.log10(1 + Math.max(0, usdcIn24h));
  return Math.max(7, Math.min(28, r));
}

const CENTRES: Record<Tier, [number, number]> = { HIGH: [0.3, 0.5], MEDIUM: [0.68, 0.28], LOW: [0.7, 0.74] };

export function layoutMap(nodes: MapNode[], edges: MapEdge[], opts: { width?: number; height?: number; iterations?: number } = {}): LayoutResult {
  const W = opts.width ?? LAYOUT_W;
  const H = opts.height ?? LAYOUT_H;
  const iterations = opts.iterations ?? 40;
  const byTier: Record<Tier, MapNode[]> = { HIGH: [], MEDIUM: [], LOW: [] };
  for (const n of nodes) (byTier[n.tier] ?? byTier.MEDIUM).push(n);
  const placed: Placed[] = [];
  const clusters: Cluster[] = [];
  for (const tier of ["HIGH", "MEDIUM", "LOW"] as Tier[]) {
    const list = [...byTier[tier]].sort((a, b) => b.usdcIn24h - a.usdcIn24h || a.address.localeCompare(b.address));
    const [fx, fy] = CENTRES[tier];
    const cx = fx * W, cy = fy * H;
    const radii = list.map((n) => nodeRadius(n.usdcIn24h));
    const meanD = radii.length ? (radii.reduce((s, r) => s + r, 0) / radii.length) * 2 : 20;
    const spacing = (meanD + 6) * 0.62;
    list.forEach((n, i) => {
      const rad = spacing * Math.sqrt(i);
      const ang = i * GOLDEN;
      placed.push({ address: n.address, tier, x: cx + rad * Math.cos(ang), y: cy + rad * Math.sin(ang), r: radii[i] });
    });
    clusters.push({ tier, cx, cy, count: list.length, radius: spacing * Math.sqrt(Math.max(1, list.length)) + meanD });
  }
  const idx = new Map<string, number>();
  placed.forEach((p, i) => idx.set(p.address, i));
  const centreOf = (p: Placed) => clusters.find((c) => c.tier === p.tier)!;
  const links: [number, number][] = [];
  for (const e of edges) {
    const a = idx.get(e.from), b = idx.get(e.to);
    if (a != null && b != null && a !== b) links.push([a, b]);
  }

  for (let it = 0; it < iterations; it++) {
    // centre pull (keeps clusters compact)
    for (const p of placed) {
      const c = centreOf(p);
      p.x += (c.cx - p.x) * 0.03;
      p.y += (c.cy - p.y) * 0.03;
    }
    // weak edge attraction (same-tier only, so clusters stay readable)
    for (const [a, b] of links) {
      const pa = placed[a], pb = placed[b];
      if (pa.tier !== pb.tier) continue;
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const d = Math.hypot(dx, dy) || 1;
      const want = pa.r + pb.r + 24;
      if (d <= want) continue;
      const k = ((d - want) / d) * 0.02;
      pa.x += dx * k; pa.y += dy * k;
      pb.x -= dx * k; pb.y -= dy * k;
    }
    // collision
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i], b = placed[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const min = a.r + b.r + 5;
        let d = Math.hypot(dx, dy);
        if (d >= min) continue;
        if (d < 1e-6) {
          // coincident: deterministic nudge
          const ang = (i * 7 + j * 13) % 360;
          b.x += Math.cos(ang) * 0.5; b.y += Math.sin(ang) * 0.5;
          d = 0.5;
        }
        const push = (min - d) / 2;
        const ux = dx / d, uy = dy / d;
        a.x -= ux * push; a.y -= uy * push;
        b.x += ux * push; b.y += uy * push;
      }
    }
    // bounds
    for (const p of placed) {
      p.x = Math.min(W - p.r - 10, Math.max(p.r + 10, p.x));
      p.y = Math.min(H - p.r - 10, Math.max(p.r + 10, p.y));
    }
  }
  for (const p of placed) {
    p.x = Math.round(p.x * 10) / 10;
    p.y = Math.round(p.y * 10) / 10;
  }
  for (const c of clusters) {
    const mine = placed.filter((p) => p.tier === c.tier);
    c.radius = mine.length ? Math.max(...mine.map((p) => Math.hypot(p.x - c.cx, p.y - c.cy) + p.r)) + 18 : 40;
  }
  return { width: W, height: H, nodes: placed, clusters, byAddress: new Map(placed.map((p) => [p.address, p])) };
}
