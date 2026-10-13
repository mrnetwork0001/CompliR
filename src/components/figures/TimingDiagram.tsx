"use client";
/**
 * TimingDiagram - one screen as a logic-analyser capture.
 * Five lanes (EVIDENCE with six concurrent sub-traces, RULES, ANALYST, ATTESTATION, REGISTRY·LEDGER) draw digital
 * waveforms over a 0–2.4 s axis. A time cursor sweeps left→right; when it crosses a lane's rising edge the lane's
 * mono readout on the right updates. After the sweep a dashed "re-screen in 24 h" return carries the cursor back
 * to 0 and the capture repeats. SVG + rAF (~30 fps), paused off-screen, static under reduced motion.
 * Coordinates are rounded to 2 dp (r2) so server and client serialise identically.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import styles from "./TimingDiagram.module.css";

const T_END = 2400; // pipeline ms shown on the axis
const SLOW = 2.1; // real ms per pipeline ms → one sweep ≈ 5 s
const HOLD = 1500; // real ms spent on the re-screen return
const CYCLE = T_END * SLOW + HOLD;
const STATIC_T = 1480; // cursor position under reduced motion (analyst active)

interface Source { id: string; end: number; timeout?: boolean }
const SOURCES: Source[] = [
  { id: "yente", end: 620 },
  { id: "arc-graph", end: 880 },
  { id: "blacklist", end: 310 },
  { id: "payee-book", end: 140 },
  { id: "network", end: 540 },
  { id: "tips", end: 1000, timeout: true },
];
interface Lane { id: string; start: number; end: number; guard?: number; async?: boolean }
const LANES: Lane[] = [
  { id: "EVIDENCE", start: 0, end: 1000 },
  { id: "RULES", start: 1000, end: 1060 },
  { id: "ANALYST", start: 1060, end: 1900, guard: 1820 },
  { id: "ATTESTATION", start: 1900, end: 2000 },
  { id: "REGISTRY·LEDGER", start: 2000, end: 2400, async: true },
];

const r2 = (v: number) => Math.round(v * 100) / 100;
const fmtMs = (t: number) => (t === 0 ? "0 ms" : t < 1000 ? `${t}` : `${(t / 1000).toFixed(1)} s`);

/** Readout text for a lane at pipeline time t (null = not reached yet). */
function readout(i: number, t: number): string | null {
  const l = LANES[i];
  if (t < l.start) return null;
  switch (i) {
    case 0: {
      const done = SOURCES.filter((s) => s.end <= t).length;
      const to = t >= 1000 ? " · 1 timeout" : "";
      return `${done}/6 sources${to}`;
    }
    case 1:
      return "score 23 · MEDIUM";
    case 2:
      return t >= (l.guard ?? Infinity) ? "limits 250/1000 · EDD 2" : "rationale ≤120 w · clamp";
    case 3:
      return "0x1bb2…ab · valid 24 h";
    default:
      return t >= l.end ? "tx pending → #25,714,409" : "tx pending";
  }
}

const RM = "(prefers-reduced-motion: reduce)";
const subscribeRM = (cb: () => void) => { const mq = window.matchMedia(RM); mq.addEventListener("change", cb); return () => mq.removeEventListener("change", cb); };
const getRM = () => window.matchMedia(RM).matches;
const getRMServer = () => false;

export default function TimingDiagram() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(1000);
  const [phase, setPhase] = useState(0);
  const reduced = useSyncExternalStore(subscribeRM, getRM, getRMServer);

  // measure
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver((es) => { const cw = es[0]?.contentRect.width; if (cw && cw > 0) setW(Math.round(cw)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // animate while visible
  useEffect(() => {
    if (reduced) return;
    const el = wrapRef.current; if (!el) return;
    let raf = 0; let last = 0; let visible = true; let offset = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!visible || now - last < 33) return; // ~30 fps
      last = now;
      setPhase((now - offset) % CYCLE);
    };
    const io = new IntersectionObserver(([e]) => {
      const v = e.isIntersecting;
      if (v && !visible) offset = performance.now(); // restart the capture when it scrolls back into view
      visible = v;
    }, { threshold: 0.05 });
    io.observe(el);
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); io.disconnect(); };
  }, [reduced]);

  // ── layout (viewBox units == CSS px) ──
  const compact = w < 640;
  const labelW = compact ? 64 : 150; // compact: gutter holds the sub-trace names, lane names move inside the plot
  const readW = compact ? 0 : 236;
  const padR = compact ? 8 : 12;
  const plotX = labelW;
  const plotW = Math.max(120, w - labelW - readW - padR);
  const readX = plotX + plotW + 14;
  const axisY = 22;
  const plotTop = 30;
  const SUB_PITCH = 11; const SUB_AMP = 6;
  const laneH = 36; const AMP = 12;
  const evPad = compact ? 13 : 8;
  const evH = evPad + SOURCES.length * SUB_PITCH + 8;
  const laneTops: number[] = [];
  let y = plotTop;
  for (let i = 0; i < LANES.length; i++) { laneTops.push(y); y += i === 0 ? evH : laneH; }
  const plotBottom = y;
  const loopY = plotBottom + 16;
  const H = loopY + 16;
  const x = (t: number) => r2(plotX + (t / T_END) * plotW);
  const xEnd = x(T_END);

  // ── time ──
  const sweeping = reduced ? true : phase < T_END * SLOW;
  const tc = reduced ? STATIC_T : sweeping ? phase / SLOW : T_END;
  const holdK = reduced || sweeping ? 0 : Math.min(1, (phase - T_END * SLOW) / HOLD);
  const xc = x(tc);
  const cursorOpacity = r2(holdK > 0 ? Math.max(0, 1 - holdK * 2.2) : 1);

  // trace path helpers: low = baseline, high = baseline - amp
  const pulse = (x0: number, x1: number, low: number, amp: number, tail = xEnd) => `M${x(0)} ${r2(low)} H${x0} V${r2(low - amp)} H${x1} V${r2(low)} H${tail}`;
  const laneLow = (i: number) => (i === 0 ? 0 : laneTops[i] + laneH - 11);

  const readouts = LANES.map((_, i) => readout(i, tc));

  return (
    <div ref={wrapRef} className={styles.wrap} data-compact={compact ? "true" : undefined}>
      <svg viewBox={`0 0 ${w} ${H}`} className={styles.svg} role="img" aria-labelledby="td-title td-desc">
        <title id="td-title">Pipeline timing diagram</title>
        <desc id="td-desc">
          One screen over 2.4 seconds: six evidence sources run concurrently from 0 to 1 s (one times out), deterministic rules score in 60 ms, the analyst writes
          for 840 ms and is clamped by a guard, the attestation is signed in 100 ms, and the registry write settles asynchronously. Re-screened in 24 h.
        </desc>
        <defs>
          <clipPath id="td-reveal">
            <rect x={plotX - 1} y={0} width={r2(Math.max(0, xc - plotX + 1))} height={H} />
          </clipPath>
        </defs>

        {/* grid */}
        {Array.from({ length: T_END / 100 + 1 }, (_, i) => i * 100).map((t) => (
          <line key={`g${t}`} x1={x(t)} x2={x(t)} y1={plotTop} y2={plotBottom} className={t % 400 === 0 ? styles.gridMajor : styles.grid} />
        ))}
        {laneTops.map((top, i) => (
          <line key={`r${i}`} x1={0} x2={w - padR} y1={r2(top)} y2={r2(top)} className={styles.laneRule} />
        ))}
        <line x1={0} x2={w - padR} y1={plotBottom} y2={plotBottom} className={styles.laneRule} />

        {/* axis */}
        <line x1={plotX} x2={xEnd} y1={axisY} y2={axisY} className={styles.axis} />
        {Array.from({ length: T_END / 100 + 1 }, (_, i) => i * 100).map((t) => {
          const major = t % 400 === 0;
          const show = major && (!compact || t % 800 === 0);
          return (
            <g key={`a${t}`}>
              <line x1={x(t)} x2={x(t)} y1={axisY - (major ? 6 : 3)} y2={axisY} className={styles.tick} />
              {show && (
                <text x={x(t)} y={axisY - 9} textAnchor={t === 0 ? "start" : t === T_END ? "end" : "middle"} className={styles.axisLabel}>
                  {fmtMs(t)}
                </text>
              )}
            </g>
          );
        })}

        {/* lane labels: left gutter, or inside the plot when compact */}
        {LANES.map((l, i) => {
          const top = laneTops[i];
          if (compact) {
            return (
              <text key={l.id} x={plotX + 4} y={r2(top + 9)} className={styles.laneLabelIn}>
                {i === 4 ? "REGISTRY" : l.id}
              </text>
            );
          }
          const cy = i === 0 ? top + 8 + 4 : top + laneH / 2 + 3.5;
          return (
            <text key={l.id} x={10} y={r2(cy)} className={styles.laneLabel}>
              {l.id}
            </text>
          );
        })}

        {/* EVIDENCE sub-traces */}
        {SOURCES.map((s, j) => {
          const low = laneTops[0] + evPad + j * SUB_PITCH + SUB_AMP + 2;
          const d = pulse(x(0), x(s.end), low, SUB_AMP);
          const active = tc >= 0 && tc < s.end;
          const hotFrom = Math.max(x(0), xc - 36);
          return (
            <g key={s.id}>
              <text x={plotX - 8} y={r2(low)} textAnchor="end" className={styles.subLabel}>{s.id}</text>
              <path d={d} className={styles.trace} />
              <path d={d} className={`${styles.traceInk} ${s.timeout ? styles.traceDash : ""}`} clipPath="url(#td-reveal)" />
              {active && <path d={`M${r2(hotFrom)} ${r2(low - SUB_AMP)} H${xc}`} className={styles.traceHot} />}
              {s.timeout && (
                <g opacity={tc >= s.end ? 1 : 0.35}>
                  <line x1={x(s.end)} x2={x(s.end)} y1={r2(low - SUB_AMP - 3)} y2={r2(low + 3)} className={styles.timeout} />
                  <text x={x(s.end) + 4} y={r2(low)} className={styles.timeoutLabel}>t/o</text>
                </g>
              )}
            </g>
          );
        })}

        {/* single-trace lanes */}
        {LANES.slice(1).map((l, k) => {
          const i = k + 1;
          const low = laneLow(i);
          const xs = x(l.start), xe = x(l.end);
          const d = pulse(xs, xe, low, AMP);
          const active = tc >= l.start && tc < l.end;
          const hotFrom = Math.max(xs, xc - 36);
          return (
            <g key={l.id}>
              <path d={d} className={styles.trace} />
              <path d={d} className={`${styles.traceInk} ${l.async ? styles.traceDash : ""}`} clipPath="url(#td-reveal)" />
              {active && (
                <>
                  <line x1={xs} x2={xs} y1={r2(low)} y2={r2(low - AMP)} className={styles.edgeHot} />
                  <path d={`M${r2(hotFrom)} ${r2(low - AMP)} H${xc}`} className={`${styles.traceHot} ${l.async ? styles.traceDash : ""}`} />
                </>
              )}
              {l.guard !== undefined && (
                <g opacity={tc >= l.guard ? 1 : 0.4}>
                  <line x1={x(l.guard)} x2={x(l.guard)} y1={r2(low - AMP - 5)} y2={r2(low - AMP + 4)} className={styles.guard} />
                  <text x={x(l.guard) + 4} y={r2(low - AMP - 1)} className={styles.guardLabel}>guard</text>
                </g>
              )}
            </g>
          );
        })}

        {/* readouts (wide layout) */}
        {!compact && LANES.map((l, i) => {
          const top = laneTops[i];
          const cy = i === 0 ? top + 8 + 4 : top + laneH / 2 + 3.5;
          const v = readouts[i];
          return (
            <text key={`ro${l.id}`} x={readX} y={r2(cy)} className={`${styles.readout} ${v === null ? styles.readoutIdle : ""}`}>
              {v ?? "-"}
            </text>
          );
        })}

        {/* re-screen loop */}
        <path d={`M${xEnd} ${plotBottom} V${loopY} H${x(0)} V${plotBottom + 4}`} className={styles.loop} />
        <path d={`M${x(0)} ${plotBottom + 1} l-3 5 h6 z`} className={styles.loopArrow} />
        <text x={r2(plotX + plotW / 2)} y={loopY - 4} textAnchor="middle" className={styles.loopLabel}>
          {compact ? "re-screen in 24 h" : "re-screen in 24 h · HIGH 1 h · MEDIUM 24 h · LOW 7 d · tier.changed webhook"}
        </text>
        {holdK > 0 && <circle cx={r2(xEnd - (xEnd - x(0)) * holdK)} cy={loopY} r={2.2} className={styles.loopDot} />}

        {/* cursor */}
        <g opacity={cursorOpacity}>
          <line x1={xc} x2={xc} y1={axisY} y2={plotBottom} className={styles.cursor} />
          <path d={`M${xc} ${axisY + 1} l-3.5 -5 h7 z`} className={styles.cursorHead} />
          {(() => {
            const label = `${Math.round(tc)} ms`;
            const lw = label.length * 6.2 + 8;
            const lx = xc + lw + 8 > xEnd ? xc - lw - 6 : xc + 6;
            return (
              <g>
                <rect x={r2(lx)} y={3} width={r2(lw)} height={14} className={styles.cursorLabelBg} />
                <text x={r2(lx + 4)} y={14} className={styles.cursorLabel}>{label}</text>
              </g>
            );
          })()}
        </g>
      </svg>

      {/* compact layout: readouts below the capture */}
      <ol className={styles.readouts} aria-hidden={!compact}>
        {LANES.map((l, i) => (
          <li key={l.id}>
            <span>{l.id}</span>
            <span className={readouts[i] === null ? styles.idle : undefined}>{readouts[i] ?? "-"}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
