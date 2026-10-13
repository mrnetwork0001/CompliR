"use client";
/**
 * MapCanvas - the Trust Map as an instrument: concentric tier rings (HIGH inner … OBSERVED outer) around the chain
 * readout, nodes as ring + core marks (core ∝ log USDC in 24 h), directional dashed signal edges, a crosshair + mono
 * readout on the focused mark, a 20 s radar sweep that brightens what it passes, corner brackets, a block scale and a
 * legend row. SVG + rAF (≤30 fps, paused off-screen, static under reduced motion). Coordinates rounded to 2 dp (r2).
 */
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Address, Tier } from "@/lib/types";
import { BANDS, RING_RADIUS, layoutMap, LAYOUT_H, LAYOUT_W, type Band, type LayoutResult, type Placed } from "@/lib/trustmap/layout";
import type { MapCandidate, MapEdge, MapNode, MapStats } from "@/lib/trustmap/types";
import { short } from "@/components/api";
import styles from "./TrustMap.module.css";

const DAY = 86_400;
const SWEEP_PERIOD = 20_000; // ms per revolution
const LIT_MS = 2_600;
const MAX_EDGES = 320;
const r2 = (v: number) => Math.round(v * 100) / 100;
const TAU = Math.PI * 2;
const norm = (a: number) => ((a % TAU) + TAU) % TAU;
const fmtN = (n: number, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d });
const fmtBlock = (b: number | null | undefined) => (b == null ? "-" : `#${fmtN(b)}`);
const CH = 5.45; // approx. advance of the 9 px mono face
const TIER_VAR: Record<Tier, string> = { LOW: "var(--low)", MEDIUM: "var(--medium)", HIGH: "var(--high)" };

const RM = "(prefers-reduced-motion: reduce)";
const subscribeRM = (cb: () => void) => { const mq = window.matchMedia(RM); mq.addEventListener("change", cb); return () => mq.removeEventListener("change", cb); };
const getRM = () => window.matchMedia(RM).matches;
const getRMServer = () => false;

export type Focusable = { kind: "node"; node: MapNode } | { kind: "candidate"; candidate: MapCandidate };

interface Props {
  nodes: MapNode[];
  candidates: MapCandidate[];
  edges: MapEdge[];
  stats: MapStats | null;
  selected: Address | null;
  hovered: Address | null;
  now: number;
  onSelect: (a: Address | null) => void;
  onHover: (a: Address | null) => void;
}

export function MapCanvas({ nodes, candidates, edges, stats, selected, hovered, now, onSelect, onHover }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const reduced = useSyncExternalStore(subscribeRM, getRM, getRMServer);
  const layout = useMemo(() => layoutMap(nodes, edges, { candidates }), [nodes, edges, candidates]);
  const [frame, setFrame] = useState<{ t: number; lit: Record<string, number> }>({ t: 0, lit: {} });
  const lastSweep = useRef(0);

  // phone: the canvas keeps its width and scrolls; start centred on the chain readout
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (el.scrollWidth > el.clientWidth) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, []);

  // radar sweep: ≤30 fps, only while on screen, never under reduced motion
  useEffect(() => {
    if (reduced) return;
    const el = wrapRef.current;
    if (!el) return;
    let raf = 0, last = 0, visible = true, litMap: Record<string, number> = {};
    const start = performance.now();
    const tick = (nowMs: number) => {
      raf = requestAnimationFrame(tick);
      if (!visible || nowMs - last < 33) return;
      last = nowMs;
      const t = nowMs - start;
      const sweep = norm((t / SWEEP_PERIOD) * TAU);
      const prev = lastSweep.current;
      lastSweep.current = sweep;
      let changed = false;
      for (const p of layout.nodes) {
        const a = norm(p.angle);
        const hit = prev <= sweep ? a > prev && a <= sweep : a > prev || a <= sweep;
        if (hit) { if (!changed) { litMap = { ...litMap }; changed = true; } litMap[p.address] = t; }
      }
      if (changed) for (const k of Object.keys(litMap)) if (t - litMap[k] > LIT_MS) delete litMap[k];
      setFrame({ t, lit: litMap });
    };
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0.02 });
    io.observe(el);
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); io.disconnect(); };
  }, [reduced, layout]);

  const focus = hovered ?? selected;
  const hasDemo = nodes.some((n) => n.source === "demo") || candidates.some((c) => c.source === "demo");
  const lastTick = stats?.lastTick ?? null;
  const tickAge = lastTick ? Math.max(0, now - lastTick.at) : null;
  const ageText = tickAge == null ? "no tick yet" : tickAge < 90 ? `${tickAge} s ago` : tickAge < 5400 ? `${Math.round(tickAge / 60)} min ago` : `${Math.round(tickAge / 3600)} h ago`;
  const W = layout.width, H = layout.height, CX = layout.cx, CY = layout.cy;

  return (
    <div ref={wrapRef} className={styles.mapScroll}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={styles.svg}
        role="img"
        aria-label={`Trust map: ${nodes.length} graded counterparties, ${candidates.length} observed addresses, ${edges.length} USDC transfers among them`}
        onClick={(e) => { if (e.target === e.currentTarget) onSelect(null); }}
      >
        <defs>
          <marker id="tm-head" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0 0.5 L5.5 3 L0 5.5 z" className={styles.edgeHead} />
          </marker>
          <marker id="tm-head-hot" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0 0.5 L5.5 3 L0 5.5 z" className={styles.edgeHeadHot} />
          </marker>
          <radialGradient id="tm-wedge" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform={`translate(${CX} ${CY}) scale(${RING_RADIUS.OBSERVED + 18})`}>
            <stop offset="0" stopColor="var(--acc)" stopOpacity="0.14" />
            <stop offset="1" stopColor="var(--acc)" stopOpacity="0" />
          </radialGradient>
        </defs>

        <Chrome W={W} H={H} stats={stats} ageText={ageText} graded={nodes.length} observed={candidates.length} edgeCount={edges.length} hasDemo={hasDemo} />

        {/* rings + labels */}
        {layout.rings.map((rg) => (
          <g key={rg.band} aria-hidden="true">
            <circle cx={CX} cy={CY} r={rg.radius} className={rg.band === "OBSERVED" ? styles.ringObserved : styles.ring} />
            <text x={r2(CX + 6)} y={r2(CY - rg.radius - 5)} className={styles.ringLabel} style={rg.band !== "OBSERVED" ? { fill: TIER_VAR[rg.band] } : undefined}>
              {rg.band} · {rg.count}
            </text>
          </g>
        ))}
        {/* radial ticks every 30° on the outer ring */}
        {Array.from({ length: 12 }, (_, i) => (i / 12) * TAU).map((a) => (
          <line key={a} x1={r2(CX + Math.cos(a) * (RING_RADIUS.OBSERVED + 10))} y1={r2(CY + Math.sin(a) * (RING_RADIUS.OBSERVED + 10))} x2={r2(CX + Math.cos(a) * (RING_RADIUS.OBSERVED + 16))} y2={r2(CY + Math.sin(a) * (RING_RADIUS.OBSERVED + 16))} className={styles.tick} />
        ))}

        <Sweep t={frame.t} reduced={reduced} CX={CX} CY={CY} />

        <CentreReadout CX={CX} CY={CY} cursor={stats?.cursorBlock ?? null} />

        <Graph layout={layout} nodes={nodes} candidates={candidates} edges={edges} focus={focus} selected={selected} now={now} onSelect={onSelect} onHover={onHover} />

        {/* sweep halos: only the marks it just passed */}
        {!reduced && Object.entries(frame.lit).map(([addr, at]) => {
          const p = layout.byAddress.get(addr);
          if (!p) return null;
          const k = Math.max(0, 1 - (frame.t - at) / LIT_MS);
          if (k <= 0) return null;
          return <circle key={addr} cx={p.x} cy={p.y} r={r2(p.r + 6 * k)} fill={p.tier ? TIER_VAR[p.tier] : "var(--acc)"} opacity={r2(0.28 * k)} pointerEvents="none" />;
        })}

        <Focus layout={layout} nodes={nodes} candidates={candidates} edges={edges} focus={focus} />
      </svg>
    </div>
  );
}

/* ─── instrument chrome: brackets, tailing readout, block scale, legend ───────── */
function Chrome({ W, H, stats, ageText, graded, observed, edgeCount, hasDemo }: { W: number; H: number; stats: MapStats | null; ageText: string; graded: number; observed: number; edgeCount: number; hasDemo: boolean }) {
  const lt = stats?.lastTick ?? null;
  const m = 12, arm = 10;
  const corners = [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]] as const;
  // bottom scale: the last tick's block window
  const sx0 = 28, sx1 = W - 28, sy = H - 46;
  const from = lt?.fromBlock ?? null, to = lt?.toBlock ?? null;
  const span = from != null && to != null ? Math.max(1, to - from) : null;
  const segs = 8;
  const legend: { kind: "tier" | "observed" | "pulse" | "demo"; tier?: Tier; text: string }[] = [
    { kind: "tier", tier: "HIGH", text: "HIGH · HOLD" },
    { kind: "tier", tier: "MEDIUM", text: "MEDIUM · LIMITS" },
    { kind: "tier", tier: "LOW", text: "LOW · PAY" },
    { kind: "observed", text: "OBSERVED · UNGRADED" },
    { kind: "pulse", text: "TIER CHANGED 24H" },
    ...(hasDemo ? [{ kind: "demo" as const, text: "DEMO SEED" }] : []),
  ];
  let lx = 28;
  return (
    <g aria-hidden="true">
      {corners.map(([x, y, dx, dy], i) => (
        <path key={i} d={`M${x + dx * arm} ${y} H${x} V${y + dy * arm}`} className={styles.bracket} />
      ))}
      {/* top-left: tailing status */}
      <circle cx={30} cy={30} r={3} className={styles.liveDotSvg} />
      <text x={40} y={33} className={styles.chromeText}>TAILING · LAST TICK {ageText.toUpperCase()}{lt?.partial ? " · PARTIAL" : ""}{lt?.rateLimited ? " · RATE-LIMITED" : ""}</text>
      <text x={28} y={47} className={styles.chromeSub}>
        {lt ? `BLOCKS ${fmtN(lt.fromBlock ?? 0)} – ${fmtN(lt.toBlock ?? 0)} · ${lt.logs} LOGS · ${lt.recipients} RECIPIENTS · ${lt.graded} GRADED · ${lt.rpcCalls} RPC` : "WAITING FOR THE FIRST TAILER TICK"}
      </text>
      {/* top-right: figure id + counts */}
      <text x={W - 28} y={33} textAnchor="end" className={styles.chromeText}>FIG. TRUST MAP · ARC 5042</text>
      <text x={W - 28} y={47} textAnchor="end" className={styles.chromeSub}>{graded} GRADED · {observed} OBSERVED · {edgeCount} EDGES</text>
      {/* bottom scale */}
      <line x1={sx0} x2={sx1} y1={sy} y2={sy} className={styles.scale} />
      {Array.from({ length: segs + 1 }, (_, i) => {
        const x = r2(sx0 + ((sx1 - sx0) * i) / segs);
        const major = i % 4 === 0;
        const label = span == null ? (i === 0 ? "NO TICK YET" : null) : major ? (i === 0 ? fmtBlock(from) : i === segs ? fmtBlock(to) : `+${fmtN(Math.round((span * i) / segs))}`) : null;
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={sy - (major ? 6 : 3)} y2={sy} className={styles.tick} />
            {label && <text x={x} y={sy - 9} textAnchor={i === 0 ? "start" : i === segs ? "end" : "middle"} className={styles.chromeSub}>{label}</text>}
          </g>
        );
      })}
      <text x={sx1} y={sy + 13} textAnchor="end" className={styles.chromeSub}>{span == null ? "BLOCK WINDOW" : `BLOCK WINDOW · ${fmtN(span + 1)} BLOCKS · ≈ ${fmtN(Math.round((span + 1) / 2))} S OF CHAIN`}</text>
      {/* legend row */}
      {legend.map((l) => {
        const x = lx;
        lx += 14 + l.text.length * CH + 16;
        return (
          <g key={l.text} transform={`translate(${x} ${H - 22})`}>
            {l.kind === "tier" && (<><circle r={4.5} fill="none" stroke={TIER_VAR[l.tier!]} strokeWidth={1} /><circle r={2} fill={TIER_VAR[l.tier!]} /></>)}
            {l.kind === "observed" && (<><circle r={4.5} className={styles.markRingObserved} /><circle r={1.6} className={styles.markCoreObserved} /></>)}
            {l.kind === "pulse" && <circle r={5} className={styles.legendPulse} />}
            {l.kind === "demo" && (<><circle r={4.5} className={styles.markRingDemo} /><circle r={1.5} className={styles.markCoreObserved} /></>)}
            <text x={10} y={3} className={styles.chromeSub}>{l.text}</text>
          </g>
        );
      })}
    </g>
  );
}

function CentreReadout({ CX, CY, cursor }: { CX: number; CY: number; cursor: number | null }) {
  return (
    <g aria-hidden="true" pointerEvents="none">
      <text x={CX} y={CY - 10} textAnchor="middle" className={styles.centreKicker}>ARC · 5042</text>
      <text x={CX} y={CY + 8} textAnchor="middle" className={styles.centreBlock}>{cursor == null ? "—" : fmtBlock(cursor)}</text>
      <text x={CX} y={CY + 22} textAnchor="middle" className={styles.centreSub}>CURSOR BLOCK</text>
    </g>
  );
}

function Sweep({ t, reduced, CX, CY }: { t: number; reduced: boolean; CX: number; CY: number }) {
  const R = RING_RADIUS.OBSERVED + 18;
  const a = reduced ? Math.PI * 1.72 : norm((t / SWEEP_PERIOD) * TAU);
  const sx = r2(CX + Math.cos(a) * R), sy = r2(CY + Math.sin(a) * R);
  const a0 = a - 0.5;
  const wedge = `M${CX},${CY} L${r2(CX + Math.cos(a0) * R)},${r2(CY + Math.sin(a0) * R)} A${R},${R} 0 0 1 ${sx},${sy} Z`;
  return (
    <g aria-hidden="true" pointerEvents="none">
      <path d={wedge} fill="url(#tm-wedge)" />
      <line x1={CX} y1={CY} x2={sx} y2={sy} className={styles.sweep} />
    </g>
  );
}

/* ─── edges + marks (memoised: the sweep never re-renders this layer) ────────── */
interface GraphProps {
  layout: LayoutResult; nodes: MapNode[]; candidates: MapCandidate[]; edges: MapEdge[]; focus: Address | null; selected: Address | null; now: number;
  onSelect: (a: Address | null) => void; onHover: (a: Address | null) => void;
}
const Graph = memo(function Graph({ layout, nodes, candidates, edges, focus, selected, now, onSelect, onHover }: GraphProps) {
  const byAddr = useMemo(() => new Map<Address, MapNode>(nodes.map((n) => [n.address, n])), [nodes]);
  const candByAddr = useMemo(() => new Map<Address, MapCandidate>(candidates.map((c) => [c.address, c])), [candidates]);
  const shown = useMemo(() => [...edges].sort((a, b) => b.usdc - a.usdc).slice(0, MAX_EDGES), [edges]);
  const neighbours = useMemo(() => {
    const s = new Set<Address>();
    if (focus) for (const e of edges) { if (e.from === focus) s.add(e.to); if (e.to === focus) s.add(e.from); }
    return s;
  }, [edges, focus]);
  // which marks carry a label: every graded node while the map is small, otherwise the biggest ones + the focus neighbourhood
  const labelled = useMemo(() => {
    const s = new Set<Address>();
    const g = [...nodes].sort((a, b) => b.usdcIn24h - a.usdcIn24h);
    for (const n of g.slice(0, nodes.length <= 40 ? nodes.length : 28)) s.add(n.address);
    const c = [...candidates].sort((a, b) => b.usdcIn24h - a.usdcIn24h);
    for (const x of c.slice(0, 10)) s.add(x.address);
    return s;
  }, [nodes, candidates]);
  const CX = layout.cx, CY = layout.cy;
  const edgeW = (usdc: number) => r2(Math.max(0.6, Math.min(2.4, 0.6 + Math.log10(1 + usdc) * 0.5)));
  // labels of angular neighbours alternate between two radial offsets so they never sit on top of each other
  const labelOffset = useMemo(() => {
    const m = new Map<Address, number>();
    for (const band of BANDS) {
      const mine = layout.nodes.filter((p) => p.band === band && (labelled.has(p.address) || p.address === focus || neighbours.has(p.address))).sort((a, b) => a.angle - b.angle);
      let prev: Placed | null = null, alt = 0;
      for (const p of mine) {
        alt = prev && p.angle - prev.angle < 0.16 ? 1 - alt : 0;
        m.set(p.address, alt * 13);
        prev = p;
      }
    }
    return m;
  }, [layout, labelled, focus, neighbours]);

  return (
    <g>
      {shown.map((e, i) => {
        const a = layout.byAddress.get(e.from), b = layout.byAddress.get(e.to);
        if (!a || !b) return null;
        const d = edgePath(a, b, CX, CY);
        if (!d) return null;
        const hot = focus != null && (e.from === focus || e.to === focus);
        const dim = focus != null && !hot;
        const high = !hot && ((byAddr.get(e.from)?.tier === "HIGH") || (byAddr.get(e.to)?.tier === "HIGH"));
        return (
          <path
            key={`${e.txHash}-${i}`} d={d.d} fill="none"
            className={`${styles.edge} ${hot ? styles.edgeHot : ""} ${dim ? styles.edgeDim : ""} ${high ? styles.edgeHigh : ""}`}
            style={{ strokeWidth: hot ? edgeW(e.usdc) + 0.4 : edgeW(e.usdc) }}
            markerEnd={hot ? "url(#tm-head-hot)" : "url(#tm-head)"}
          >
            <title>{`${short(e.from)} → ${short(e.to)} · ${fmtN(e.usdc, 2)} USDC · block ${e.block || "-"}${e.source === "demo" ? " · demo" : ""}`}</title>
          </path>
        );
      })}

      {layout.nodes.map((p) => {
        const n = byAddr.get(p.address);
        const c = candByAddr.get(p.address);
        const isSel = selected === p.address;
        const isFocus = focus === p.address;
        const dim = focus != null && !isFocus && !neighbours.has(p.address);
        const changed = !!n && n.changedAt != null && now - n.changedAt < DAY;
        const demo = (n?.source ?? c?.source) === "demo";
        const label = labelled.has(p.address) || isFocus || neighbours.has(p.address);
        const out = Math.cos(p.angle) >= 0;
        const lo = p.r + 5 + (labelOffset.get(p.address) ?? 0);
        const lx = r2(p.x + Math.cos(p.angle) * lo), ly = r2(p.y + Math.sin(p.angle) * lo);
        const anchor = out ? "start" : "end";
        const tierVar = p.tier ? TIER_VAR[p.tier] : undefined;
        const aria = n ? `${short(n.address)} ${n.tier} score ${n.score}` : `${short(p.address)} observed, ${fmtN(c?.usdcIn24h ?? 0)} USDC in, not graded`;
        return (
          <g
            key={p.address}
            className={`${styles.mark} ${dim ? styles.markDim : ""}`}
            role="button" tabIndex={0} aria-label={aria} aria-pressed={isSel}
            onClick={(e) => { e.stopPropagation(); onSelect(isSel ? null : p.address); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(isSel ? null : p.address); } }}
            onMouseEnter={() => onHover(p.address)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(p.address)} onBlur={() => onHover(null)}
          >
            <circle cx={p.x} cy={p.y} r={p.r + 6} fill="transparent" />
            {changed && <circle cx={p.x} cy={p.y} r={p.r + 4} className={styles.pulse} />}
            {n ? (
              <>
                <circle cx={p.x} cy={p.y} r={p.r} className={`${styles.markRing} ${demo ? styles.markRingDemo : ""} ${isFocus || isSel ? styles.markRingFocus : ""}`} style={{ stroke: isFocus || isSel ? undefined : tierVar }} />
                <circle cx={p.x} cy={p.y} r={p.core} fill={tierVar} className={styles.markCore} />
              </>
            ) : (
              <>
                <circle cx={p.x} cy={p.y} r={p.r} className={`${styles.markRingObserved} ${demo ? styles.markRingDemo : ""} ${isFocus || isSel ? styles.markRingFocus : ""}`} />
                <circle cx={p.x} cy={p.y} r={p.core} className={styles.markCoreObserved} />
              </>
            )}
            {label && (
              <g className={styles.labelGroup}>
                <text x={lx} y={r2(ly + 3)} textAnchor={anchor} className={styles.label}>
                  {short(p.address, 6, 4)}
                  {n && <tspan className={styles.labelScore} style={{ fill: tierVar }}> {String(n.score).padStart(2, "0")}</tspan>}
                  {c && <tspan className={styles.labelMeta}> · {c.usdcIn24h > 0 ? `${fmtN(c.usdcIn24h)} USDC` : `${fmtN(c.usdcOut24h)} OUT`}</tspan>}
                </text>
                {n && <Meter x={out ? lx : lx - 15} y={r2(ly + 7)} score={n.score} tier={n.tier} />}
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
});

/** 4-cell pixel meter: score quartile in the tier colour */
function Meter({ x, y, score, tier }: { x: number; y: number; score: number; tier: Tier }) {
  const on = Math.min(4, Math.max(1, Math.ceil(score / 25)));
  return (
    <g aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={r2(x + i * 4)} y={y} width={3} height={3} fill={i < on ? TIER_VAR[tier] : "var(--line-2)"} />
      ))}
    </g>
  );
}

/** quadratic path from a → b, trimmed at the marks, bent toward the centre (chord style) */
function edgePath(a: Placed, b: Placed, CX: number, CY: number): { d: string; mx: number; my: number } | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist < a.r + b.r + 4) return null;
  const ux = dx / dist, uy = dy / dist;
  const x1 = a.x + ux * (a.r + 1.5), y1 = a.y + uy * (a.r + 1.5);
  const x2 = b.x - ux * (b.r + 3), y2 = b.y - uy * (b.r + 3);
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const sameRing = a.band === b.band;
  const k = sameRing ? 0.42 : 0.12;
  const cx = mx + (CX - mx) * k, cy = my + (CY - my) * k;
  const bx = 0.25 * x1 + 0.5 * cx + 0.25 * x2, by = 0.25 * y1 + 0.5 * cy + 0.25 * y2;
  return { d: `M${r2(x1)} ${r2(y1)} Q${r2(cx)} ${r2(cy)} ${r2(x2)} ${r2(y2)}`, mx: r2(bx), my: r2(by) };
}

/* ─── crosshair + readout + amount labels for the focused mark ─────────────── */
function Focus({ layout, nodes, candidates, edges, focus }: { layout: LayoutResult; nodes: MapNode[]; candidates: MapCandidate[]; edges: MapEdge[]; focus: Address | null }) {
  if (!focus) return null;
  const p = layout.byAddress.get(focus);
  if (!p) return null;
  const n = nodes.find((x) => x.address === focus) ?? null;
  const c = candidates.find((x) => x.address === focus) ?? null;
  const W = layout.width, H = layout.height;
  const mine = edges.filter((e) => e.from === focus || e.to === focus);
  const inn = mine.filter((e) => e.to === focus).length, outn = mine.length - inn;
  const lines: { k: string; v: string; color?: string }[] = n
    ? [
        { k: "TIER", v: `${n.tier} · ${n.tier === "HIGH" ? "HOLD" : n.tier === "MEDIUM" ? "PAY WITH LIMITS" : "PAY"}`, color: TIER_VAR[n.tier] },
        { k: "SCORE", v: `${n.score} / 100` },
        { k: "IN 24H", v: `${fmtN(n.usdcIn24h, 2)} USDC` },
        { k: "LAST BLOCK", v: fmtBlock(n.lastSeenBlock) },
        { k: "EDGES", v: `${mine.length} · ${inn} IN / ${outn} OUT` },
        ...(n.changedAt != null && n.prevTier ? [{ k: "CHANGED", v: `${n.prevTier} → ${n.tier}` }] : []),
        ...(n.source === "demo" ? [{ k: "SOURCE", v: "DEMO SEED" }] : []),
      ]
    : c
      ? [
          { k: "STATUS", v: "OBSERVED · NOT GRADED", color: "var(--muted)" },
          { k: "IN 24H", v: `${fmtN(c.usdcIn24h, 2)} USDC` },
          { k: "OUT 24H", v: `${fmtN(c.usdcOut24h, 2)} USDC` },
          { k: "BLOCKS", v: `${fmtBlock(c.firstSeenBlock)} – ${fmtBlock(c.lastSeenBlock)}` },
          { k: "EDGES", v: `${mine.length} · ${inn} IN / ${outn} OUT` },
          { k: "CODE", v: c.isContract == null ? "UNKNOWN" : c.isContract ? "CONTRACT" : "EOA" },
          ...(c.source === "demo" ? [{ k: "SOURCE", v: "DEMO SEED" }] : []),
        ]
      : [];
  const bw = 250, bh = 24 + lines.length * 13 + 8;
  const bx = p.x + 18 + bw > W - 24 ? p.x - 18 - bw : p.x + 18;
  const by = Math.min(H - 60 - bh, Math.max(56, p.y - bh / 2));
  const CX = layout.cx, CY = layout.cy;
  return (
    <g aria-hidden="true" pointerEvents="none">
      <line x1={p.x} x2={p.x} y1={54} y2={H - 56} className={styles.cross} />
      <line x1={28} x2={W - 28} y1={p.y} y2={p.y} className={styles.cross} />
      <circle cx={p.x} cy={p.y} r={p.r + 3} className={styles.crossRing} />
      {/* amount labels on the edges that touch the focus */}
      {mine.slice(0, 24).map((e, i) => {
        const a = layout.byAddress.get(e.from), b = layout.byAddress.get(e.to);
        if (!a || !b) return null;
        const d = edgePath(a, b, CX, CY);
        if (!d) return null;
        const txt = `${fmtN(e.usdc, e.usdc < 100 ? 2 : 0)} USDC`;
        const w = r2(txt.length * 5 + 8);
        return (
          <g key={`${e.txHash}-${i}`} transform={`translate(${r2(d.mx - w / 2)} ${r2(d.my - 7)})`}>
            <rect width={w} height={13} className={styles.amountBg} />
            <text x={r2(w / 2)} y={9.5} textAnchor="middle" className={styles.amount}>{txt}</text>
          </g>
        );
      })}
      <g transform={`translate(${r2(bx)} ${r2(by)})`}>
        <rect width={bw} height={bh} className={styles.readoutBg} />
        <text x={8} y={15} className={styles.readoutAddr}>{focus}</text>
        <line x1={0} x2={bw} y1={20} y2={20} className={styles.readoutRule} />
        {lines.map((l, i) => (
          <g key={l.k}>
            <text x={8} y={r2(33 + i * 13)} className={styles.readoutKey}>{l.k}</text>
            <text x={bw - 8} y={r2(33 + i * 13)} textAnchor="end" className={styles.readoutVal} style={l.color ? { fill: l.color } : undefined}>{l.v}</text>
          </g>
        ))}
      </g>
    </g>
  );
}

export { BANDS, LAYOUT_H, LAYOUT_W };
export type { Band };
