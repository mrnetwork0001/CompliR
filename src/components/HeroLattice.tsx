"use client";
/**
 * HeroLattice - continuous "risk lattice" animation for the landing hero, drawn from real data only.
 * Graph: GET /api/v1/map?limit=60&candidates=120 (graded nodes, observed candidates, USDC edges among them).
 *   centre  = the most recently graded node (a HIGH one first, if any)
 *   hop 1   = graded nodes that share an edge with the subject, else the biggest graded nodes by 24 h USDC inflow
 *   hop 2   = observed-but-ungraded candidates (no tier yet - lit in the accent colour, not a tier colour)
 *   edges   = only transfers the API actually returned between two drawn nodes
 * Readout: GET /api/v1/feed?limit=6 (real recent screenings: decision id, masked address, tier, score).
 * When the map has no graded node yet but the feed has rows, the feed rows are drawn on the inner ring ("RECENT").
 * A slow radar sweep lights each node in its tier colour as it passes. Refreshes every 30 s while the tab is visible.
 * First render is deterministic (rings + "connecting …"); data arrives in useEffect, so there is nothing to hydrate.
 * Pure SVG + rAF, no deps. Static under reduced motion.
 */
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MapSnapshot } from "@/lib/trustmap/types";
import type { FeedResponse } from "@/app/api/_lib/public-types";
import styles from "./HeroLattice.module.css";

type Tier = "LOW" | "MEDIUM" | "HIGH";
/** tier null = observed candidate, not graded yet */
interface Node { key: string; hop: 0 | 1 | 2; baseAngle: number; radius: number; tier: Tier | null; score: number | null; label: string; phase: number; speed: number }
interface Edge { a: number; b: number } // indices into nodes; a is the outer end (pulses travel a → b)
interface FeedRow { id: string; addr: string; tier: Tier; score: number }
type Graph = { mode: "graph" | "feed"; nodes: Node[]; edges: Edge[] };
type Data =
  | { status: "loading" }
  | { status: "empty"; feed: FeedRow[] }
  | { status: "error" }
  | { status: "ready"; graph: Graph; feed: FeedRow[] };

const TIER_COLOR: Record<Tier, string> = { LOW: "var(--low)", MEDIUM: "var(--medium)", HIGH: "var(--high)" };
const SIZE = 560, CX = 280, CY = 280, R1 = 118, R2 = 222;
const SWEEP_PERIOD = 14_000; // ms per revolution
const LIT_MS = 3_200;
const REFRESH_MS = 30_000;
const MAX_HOP1 = 10, MAX_HOP2 = 28;

const mask = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** small deterministic hash of an address → [0, 1) so drift phase/speed are stable across refreshes */
function h01(s: string, salt: number): number { let x = 2166136261 ^ salt; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return ((x >>> 0) % 10007) / 10007; }

function buildGraph(snap: MapSnapshot, feed: FeedRow[]): Graph | null {
  const graded = [...snap.nodes].sort((p, q) => q.lastGradedAt - p.lastGradedAt);
  if (graded.length === 0) {
    if (feed.length === 0) return null;
    // Fresh map, real screenings: subject = latest screening, inner ring = the rest of the feed.
    const [s, ...rest] = feed;
    const nodes: Node[] = [{ key: s.id, hop: 0, baseAngle: 0, radius: 0, tier: s.tier, score: s.score, label: s.addr, phase: 0, speed: 0 }];
    rest.slice(0, MAX_HOP1).forEach((r, i, arr) => nodes.push({ key: r.id, hop: 1, baseAngle: (i / arr.length) * Math.PI * 2 - Math.PI / 2, radius: R1, tier: r.tier, score: r.score, label: r.addr, phase: h01(r.id, 1) * Math.PI * 2, speed: 0.6 + h01(r.id, 2) * 0.6 }));
    return { mode: "feed", nodes, edges: [] };
  }
  const subject = graded.find((n) => n.tier === "HIGH") ?? graded[0];
  const touching = new Set<string>();
  for (const e of snap.edges) { if (e.from === subject.address) touching.add(e.to); else if (e.to === subject.address) touching.add(e.from); }
  let hop1 = graded.filter((n) => n.address !== subject.address && touching.has(n.address));
  if (hop1.length === 0) hop1 = graded.filter((n) => n.address !== subject.address).sort((p, q) => q.usdcIn24h - p.usdcIn24h);
  hop1 = hop1.slice(0, MAX_HOP1);
  const hop2 = [...snap.candidates].sort((p, q) => q.usdcIn24h + q.usdcOut24h - (p.usdcIn24h + p.usdcOut24h)).slice(0, MAX_HOP2);

  const nodes: Node[] = [{ key: subject.address, hop: 0, baseAngle: 0, radius: 0, tier: subject.tier, score: subject.score, label: mask(subject.address), phase: 0, speed: 0 }];
  const index = new Map<string, number>([[subject.address, 0]]);
  hop1.forEach((n, i) => {
    index.set(n.address, nodes.length);
    nodes.push({ key: n.address, hop: 1, baseAngle: (i / hop1.length) * Math.PI * 2 - Math.PI / 2 + (h01(n.address, 3) - 0.5) * 0.25, radius: R1 + (h01(n.address, 4) - 0.5) * 18, tier: n.tier, score: n.score, label: mask(n.address), phase: h01(n.address, 1) * Math.PI * 2, speed: 0.6 + h01(n.address, 2) * 0.6 });
  });
  // candidates sit near the hop-1 node they transact with when the API has such an edge, else spread evenly
  const near = new Map<string, number>();
  for (const e of snap.edges) {
    for (const [c, g] of [[e.to, e.from], [e.from, e.to]] as const) {
      const gi = index.get(g);
      if (gi !== undefined && nodes[gi].hop === 1 && !near.has(c)) near.set(c, gi);
    }
  }
  const perParent = new Map<number, number>();
  hop2.forEach((c, i) => {
    const gi = near.get(c.address);
    let angle: number;
    if (gi !== undefined) { const k = perParent.get(gi) ?? 0; perParent.set(gi, k + 1); angle = nodes[gi].baseAngle + (k - 1) * 0.3 + (h01(c.address, 3) - 0.5) * 0.1; }
    else angle = (i / hop2.length) * Math.PI * 2 + h01(c.address, 3) * 0.2;
    index.set(c.address, nodes.length);
    nodes.push({ key: c.address, hop: 2, baseAngle: angle, radius: R2 + (h01(c.address, 4) - 0.5) * 26, tier: null, score: null, label: mask(c.address), phase: h01(c.address, 1) * Math.PI * 2, speed: 0.5 + h01(c.address, 2) * 0.7 });
  });
  const edges: Edge[] = []; const seen = new Set<string>();
  for (const e of snap.edges) {
    const i = index.get(e.from), j = index.get(e.to);
    if (i === undefined || j === undefined || i === j) continue;
    const [a, b] = nodes[i].hop >= nodes[j].hop ? [i, j] : [j, i];
    const k = `${a}-${b}`; if (seen.has(k)) continue; seen.add(k); edges.push({ a, b });
  }
  return { mode: "graph", nodes, edges };
}

const r2 = (v: number) => Math.round(v * 100) / 100; // stable serialisation (server/client float formatting can differ)
function pos(n: Node, t: number): [number, number] {
  if (n.hop === 0) return [CX, CY];
  const drift = Math.sin(t / 1000 * n.speed + n.phase) * 0.035;
  const a = n.baseAngle + drift;
  const rad = n.radius + Math.cos(t / 1300 * n.speed + n.phase) * 5;
  return [r2(CX + Math.cos(a) * rad), r2(CY + Math.sin(a) * rad)];
}
const norm = (a: number) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
const shortId = (id: string) => `…${id.slice(-4)}`;

const RM = "(prefers-reduced-motion: reduce)";
const subscribeRM = (cb: () => void) => { const mq = window.matchMedia(RM); mq.addEventListener("change", cb); return () => mq.removeEventListener("change", cb); };
const getRM = () => window.matchMedia(RM).matches;
const getRMServer = () => false;

const NO_GRAPH: Graph = { mode: "graph", nodes: [], edges: [] };

export default function HeroLattice() {
  const [data, setData] = useState<Data>({ status: "loading" });
  const [frame, setFrame] = useState<{ t: number; lit: Record<string, number> }>({ t: 0, lit: {} });
  const t = frame.t; const lit = frame.lit;
  const reduced = useSyncExternalStore(subscribeRM, getRM, getRMServer);
  const lastSweep = useRef(0);
  const startRef = useRef<number | null>(null);
  const litRef = useRef<Record<string, number>>({});

  const graph = data.status === "ready" ? data.graph : NO_GRAPH;
  const feed = data.status === "ready" || data.status === "empty" ? data.feed : [];
  const nodes = graph.nodes;

  // fetch real data; refresh while visible
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [mr, fr] = await Promise.all([
          fetch("/api/v1/map?limit=60&candidates=120", { cache: "no-store" }),
          fetch("/api/v1/feed?limit=6", { cache: "no-store" }),
        ]);
        if (!mr.ok || !fr.ok) throw new Error(`map ${mr.status} · feed ${fr.status}`);
        const snap = (await mr.json()) as MapSnapshot;
        const fj = (await fr.json()) as FeedResponse;
        const rows: FeedRow[] = fj.items.map((i) => ({ id: i.decisionId, addr: i.addressMasked, tier: i.tier, score: i.score }));
        if (!alive) return;
        const g = buildGraph(snap, rows);
        setData(g ? { status: "ready", graph: g, feed: rows } : { status: "empty", feed: rows });
      } catch { if (alive) setData((d) => (d.status === "ready" ? d : { status: "error" })); }
    };
    void load();
    const id = setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    const onVis = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  // animate
  useEffect(() => {
    if (reduced) return;
    let raf = 0; let last = 0;
    if (startRef.current === null) startRef.current = performance.now();
    const start = startRef.current;
    const tick = (now: number) => {
      const el = now - start;
      if (now - last > 33) { // ~30 fps
        last = now;
        const sweep = norm((el / SWEEP_PERIOD) * Math.PI * 2);
        const prev = lastSweep.current; lastSweep.current = sweep;
        let changed = false;
        for (const n of nodes) {
          if (n.hop === 0) continue;
          const [px, py] = pos(n, el);
          const a = norm(Math.atan2(py - CY, px - CX));
          const hit = prev <= sweep ? a > prev && a <= sweep : a > prev || a <= sweep; // handles wrap
          if (hit) { if (!changed) { litRef.current = { ...litRef.current }; changed = true; } litRef.current[n.key] = el; }
        }
        setFrame({ t: el, lit: litRef.current });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [nodes, reduced]);

  const sweep = reduced ? Math.PI * 0.3 : norm((t / SWEEP_PERIOD) * Math.PI * 2);
  const sx = r2(CX + Math.cos(sweep) * (R2 + 40)), sy = r2(CY + Math.sin(sweep) * (R2 + 40));
  const wedge = (() => { const a0 = sweep - 0.55, R = R2 + 40; return `M${CX},${CY} L${r2(CX + Math.cos(a0) * R)},${r2(CY + Math.sin(a0) * R)} A${R},${R} 0 0 1 ${sx},${sy} Z`; })();
  const subject = nodes[0];
  const litAddrs = new Set(Object.entries(lit).filter(([, at]) => t - at < LIT_MS).map(([k]) => nodes.find((n) => n.key === k)?.label));
  const colorOf = (n: Node) => (n.tier ? TIER_COLOR[n.tier] : "var(--acc)");

  return (
    <div className={styles.wrap}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className={styles.svg} aria-hidden="true">
        <defs>
          <radialGradient id="hl-wedge" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform={`translate(${CX} ${CY}) scale(${R2 + 40})`}>
            <stop offset="0" stopColor="var(--acc)" stopOpacity="0.16" />
            <stop offset="1" stopColor="var(--acc)" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* rings + axes */}
        {[R1, R2].map((r) => <circle key={r} cx={CX} cy={CY} r={r} className={styles.ring} />)}
        <circle cx={CX} cy={CY} r={R2 + 40} className={styles.ringOuter} />
        <text x={CX + R1 + 6} y={CY - 6} className={styles.ringLabel}>{graph.mode === "feed" ? "RECENT SCREENS" : "HOP 1"}</text>
        <text x={CX + R2 + 6} y={CY - 6} className={styles.ringLabel}>{graph.mode === "feed" ? "" : "HOP 2 · OBSERVED"}</text>
        {/* sweep */}
        <path d={wedge} fill="url(#hl-wedge)" />
        <line x1={CX} y1={CY} x2={sx} y2={sy} className={styles.sweep} />
        {/* edges: only transfers the API returned */}
        {graph.edges.map((e) => {
          const n = nodes[e.a]; const [x1, y1] = pos(n, t); const [x2, y2] = pos(nodes[e.b], t);
          const l = lit[n.key]; const age = l == null ? Infinity : t - l;
          const hot = age < LIT_MS && n.tier !== null && n.tier !== "LOW";
          return <line key={`e${e.a}-${e.b}`} x1={x1} y1={y1} x2={x2} y2={y2} className={`${styles.edge} ${hot ? styles.edgeHot : ""}`} style={hot ? { stroke: colorOf(n) } : undefined} />;
        })}
        {/* pulses travelling inward along real edges */}
        {!reduced && graph.edges.map((e, i) => {
          const [x1, y1] = pos(nodes[e.a], t); const [x2, y2] = pos(nodes[e.b], t);
          const u = ((t / 2600) + i * 0.173) % 1;
          return <circle key={`p${e.a}-${e.b}`} cx={r2(x1 + (x2 - x1) * u)} cy={r2(y1 + (y2 - y1) * u)} r={1.6} className={styles.pulse} />;
        })}
        {/* nodes */}
        {nodes.map((n) => {
          const [x, y] = pos(n, t);
          const l = lit[n.key]; const age = reduced ? 0 : l == null ? Infinity : t - l;
          const k = age === Infinity ? 0 : Math.max(0, 1 - age / LIT_MS);
          const r = n.hop === 0 ? 7 : n.hop === 1 ? 4.2 : 3;
          return (
            <g key={n.key}>
              {k > 0 && n.hop !== 0 && <circle cx={x} cy={y} r={r2(r + 7 * k)} fill={colorOf(n)} opacity={r2(0.18 * k)} />}
              <circle cx={x} cy={y} r={r} className={styles.node} style={k > 0 || n.hop === 0 ? { fill: colorOf(n), opacity: n.hop === 0 ? 1 : r2(0.35 + 0.65 * k) } : undefined} />
              {k > 0.55 && n.hop !== 0 && <text x={r2(x + r + 3)} y={r2(y + 3)} className={styles.nodeLabel} opacity={r2((k - 0.55) / 0.45)}>{n.label}{n.score !== null ? ` · ${n.score}` : ""}</text>}
            </g>
          );
        })}
        {/* subject chip, or the state line */}
        {subject ? (
          <g transform={`translate(${CX - 54} ${CY + 16})`}>
            <rect width="108" height="18" className={styles.chip} />
            <text x="54" y="12.5" textAnchor="middle" className={styles.chipText}>SUBJECT {subject.label}</text>
          </g>
        ) : (
          <text x={CX} y={CY + 22} textAnchor="middle" className={styles.state}>
            {data.status === "loading" ? "connecting to Arc 5042 …" : data.status === "error" ? "ledger unreachable · retrying" : "no screenings yet"}
          </text>
        )}
      </svg>
      <ol className={styles.readout}>
        <li className={styles.readoutHead}><span>decision</span><span>subject</span><span>tier</span><span>score</span></li>
        {feed.map((r) => (
          <li key={r.id} className={`${styles.readoutRow} ${litAddrs.has(r.addr) ? styles.readoutLit : ""}`}>
            <span>{shortId(r.id)}</span><span>{r.addr}</span><span style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span><span>{r.score}</span>
          </li>
        ))}
        {data.status === "loading" && <li className={styles.readoutRow}><span>-</span><span>connecting to Arc 5042 …</span><span /><span /></li>}
        {data.status === "error" && <li className={styles.readoutRow}><span>-</span><span>ledger unreachable · retrying</span><span /><span /></li>}
        {data.status !== "loading" && data.status !== "error" && feed.length === 0 && (
          <li className={styles.readoutRow}><span>-</span><span><Link href="/explorer" className={styles.readoutLink}>no screenings yet - run one →</Link></span><span /><span /></li>
        )}
      </ol>
    </div>
  );
}
