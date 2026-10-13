"use client";
/**
 * HeroLattice — continuous "risk lattice" animation for the landing hero.
 * A 2-hop funder graph drifts around a subject; signal pulses travel inward along dashed edges;
 * a slow radar sweep grades each node as it passes (flicks it to its tier colour, then fades);
 * a mono readout ticks the last screenings. Pure SVG + rAF, no deps. Static under reduced motion.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import styles from "./HeroLattice.module.css";

type Tier = "LOW" | "MEDIUM" | "HIGH";
interface Node { id: number; hop: 0 | 1 | 2; parent: number | null; baseAngle: number; radius: number; tier: Tier; score: number; addr: string; phase: number; speed: number }

const TIER_COLOR: Record<Tier, string> = { LOW: "var(--low)", MEDIUM: "var(--medium)", HIGH: "var(--high)" };
const SIZE = 560, CX = 280, CY = 280, R1 = 118, R2 = 222;
const SWEEP_PERIOD = 14_000; // ms per revolution
const LIT_MS = 3_200;

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function addrFrom(r: () => number) { const h = "0123456789abcdef"; let a = "0x"; for (let i = 0; i < 8; i++) a += h[Math.floor(r() * 16)]; return `${a.slice(0, 6)}…${a.slice(-4)}`; }

function buildGraph(): Node[] {
  const r = rng(0xc0ffee);
  const nodes: Node[] = [{ id: 0, hop: 0, parent: null, baseAngle: 0, radius: 0, tier: "MEDIUM", score: 23, addr: "0x0000…beef", phase: 0, speed: 0 }];
  const H1 = 7;
  for (let i = 0; i < H1; i++) {
    const tier: Tier = i === 2 ? "HIGH" : i === 5 ? "MEDIUM" : "LOW";
    nodes.push({ id: nodes.length, hop: 1, parent: 0, baseAngle: (i / H1) * Math.PI * 2 + r() * 0.3, radius: R1 + (r() - 0.5) * 18, tier, score: tier === "HIGH" ? 60 + Math.floor(r() * 40) : tier === "MEDIUM" ? 21 + Math.floor(r() * 39) : Math.floor(r() * 20), addr: addrFrom(r), phase: r() * Math.PI * 2, speed: 0.6 + r() * 0.6 });
  }
  const h1 = nodes.filter((n) => n.hop === 1);
  for (const p of h1) {
    const kids = 2 + Math.floor(r() * 2);
    for (let k = 0; k < kids; k++) {
      const tier: Tier = r() < 0.08 ? "HIGH" : r() < 0.3 ? "MEDIUM" : "LOW";
      nodes.push({ id: nodes.length, hop: 2, parent: p.id, baseAngle: p.baseAngle + (k - (kids - 1) / 2) * 0.34 + (r() - 0.5) * 0.1, radius: R2 + (r() - 0.5) * 26, tier, score: tier === "HIGH" ? 61 + Math.floor(r() * 39) : tier === "MEDIUM" ? 21 + Math.floor(r() * 39) : Math.floor(r() * 20), addr: addrFrom(r), phase: r() * Math.PI * 2, speed: 0.5 + r() * 0.7 });
    }
  }
  return nodes;
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

const RM = "(prefers-reduced-motion: reduce)";
const subscribeRM = (cb: () => void) => { const mq = window.matchMedia(RM); mq.addEventListener("change", cb); return () => mq.removeEventListener("change", cb); };
const getRM = () => window.matchMedia(RM).matches;
const getRMServer = () => false;

export default function HeroLattice() {
  const nodes = useMemo(() => buildGraph(), []);
  const [frame, setFrame] = useState<{ t: number; lit: Record<number, number> }>({ t: 0, lit: {} });
  const t = frame.t; const lit = frame.lit;
  const reduced = useSyncExternalStore(subscribeRM, getRM, getRMServer);
  const lastSweep = useRef(0);
  const [readout, setReadout] = useState<{ id: number; addr: string; tier: Tier; score: number; n: number }[]>([]);
  const counter = useRef(1180);

  useEffect(() => {
    if (reduced) return;
    let raf = 0; const start = performance.now(); let last = 0; let litMap: Record<number, number> = {};
    const tick = (now: number) => {
      const el = now - start;
      if (now - last > 33) { // ~30 fps
        last = now;
        const sweep = norm((el / SWEEP_PERIOD) * Math.PI * 2);
        const prev = lastSweep.current; lastSweep.current = sweep;
        const crossed: Node[] = [];
        for (const n of nodes) {
          if (n.hop === 0) continue;
          const [px, py] = pos(n, el);
          const a = norm(Math.atan2(py - CY, px - CX));
          const hit = prev <= sweep ? a > prev && a <= sweep : a > prev || a <= sweep; // handles wrap
          if (hit) crossed.push(n);
        }
        if (crossed.length) {
          litMap = { ...litMap }; for (const n of crossed) litMap[n.id] = el;
          setReadout((r) => [...crossed.map((n) => ({ id: n.id, addr: n.addr, tier: n.tier, score: n.score, n: counter.current++ })), ...r].slice(0, 6));
        }
        setFrame({ t: el, lit: litMap });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [nodes, reduced]);

  const sweep = reduced ? Math.PI * 0.3 : norm((t / SWEEP_PERIOD) * Math.PI * 2);
  const sx = r2(CX + Math.cos(sweep) * (R2 + 40)), sy = r2(CY + Math.sin(sweep) * (R2 + 40));
  const wedge = (() => { const a0 = sweep - 0.55, R = R2 + 40; return `M${CX},${CY} L${r2(CX + Math.cos(a0) * R)},${r2(CY + Math.sin(a0) * R)} A${R},${R} 0 0 1 ${sx},${sy} Z`; })();

  return (
    <div className={styles.wrap} aria-hidden="true">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className={styles.svg}>
        <defs>
          <radialGradient id="hl-wedge" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform={`translate(${CX} ${CY}) scale(${R2 + 40})`}>
            <stop offset="0" stopColor="var(--acc)" stopOpacity="0.16" />
            <stop offset="1" stopColor="var(--acc)" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* rings + axes */}
        {[R1, R2].map((r) => <circle key={r} cx={CX} cy={CY} r={r} className={styles.ring} />)}
        <circle cx={CX} cy={CY} r={R2 + 40} className={styles.ringOuter} />
        <text x={CX + R1 + 6} y={CY - 6} className={styles.ringLabel}>HOP 1</text>
        <text x={CX + R2 + 6} y={CY - 6} className={styles.ringLabel}>HOP 2</text>
        {/* sweep */}
        <path d={wedge} fill="url(#hl-wedge)" />
        <line x1={CX} y1={CY} x2={sx} y2={sy} className={styles.sweep} />
        {/* edges */}
        {nodes.filter((n) => n.parent !== null).map((n) => {
          const [x1, y1] = pos(n, t); const p = nodes[n.parent as number]; const [x2, y2] = pos(p, t);
          const l = lit[n.id]; const age = l == null ? Infinity : t - l;
          const hot = age < LIT_MS && n.tier !== "LOW";
          return <line key={`e${n.id}`} x1={x1} y1={y1} x2={x2} y2={y2} className={`${styles.edge} ${hot ? styles.edgeHot : ""}`} style={hot ? { stroke: TIER_COLOR[n.tier] } : undefined} />;
        })}
        {/* pulses travelling inward */}
        {!reduced && nodes.filter((n) => n.parent !== null).map((n, i) => {
          const [x1, y1] = pos(n, t); const [x2, y2] = pos(nodes[n.parent as number], t);
          const u = ((t / 2600) + i * 0.173) % 1;
          return <circle key={`p${n.id}`} cx={r2(x1 + (x2 - x1) * u)} cy={r2(y1 + (y2 - y1) * u)} r={1.6} className={styles.pulse} />;
        })}
        {/* nodes */}
        {nodes.map((n) => {
          const [x, y] = pos(n, t);
          const l = lit[n.id]; const age = reduced ? 0 : l == null ? Infinity : t - l;
          const k = age === Infinity ? 0 : Math.max(0, 1 - age / LIT_MS);
          const r = n.hop === 0 ? 7 : n.hop === 1 ? 4.2 : 3;
          return (
            <g key={n.id}>
              {k > 0 && n.hop !== 0 && <circle cx={x} cy={y} r={r2(r + 7 * k)} fill={TIER_COLOR[n.tier]} opacity={r2(0.18 * k)} />}
              <circle cx={x} cy={y} r={r} className={styles.node} style={k > 0 || n.hop === 0 ? { fill: TIER_COLOR[n.tier], opacity: n.hop === 0 ? 1 : r2(0.35 + 0.65 * k) } : undefined} />
            </g>
          );
        })}
        {/* subject chip */}
        <g transform={`translate(${CX - 54} ${CY + 16})`}>
          <rect width="108" height="18" className={styles.chip} />
          <text x="54" y="12.5" textAnchor="middle" className={styles.chipText}>SUBJECT 0x0000…beef</text>
        </g>
      </svg>
      <ol className={styles.readout}>
        <li className={styles.readoutHead}><span>screen</span><span>subject</span><span>tier</span><span>score</span></li>
        {(reduced ? nodes.slice(1, 7).map((n, i) => ({ id: n.id, addr: n.addr, tier: n.tier, score: n.score, n: 1180 + i })) : readout).map((r) => (
          <li key={`${r.id}-${r.n}`} className={styles.readoutRow}>
            <span>#{r.n}</span><span>{r.addr}</span><span style={{ color: TIER_COLOR[r.tier] }}>{r.tier}</span><span>{r.score}</span>
          </li>
        ))}
        {readout.length === 0 && !reduced && <li className={styles.readoutRow}><span>—</span><span>sweep warming up</span><span /><span /></li>}
      </ol>
    </div>
  );
}
