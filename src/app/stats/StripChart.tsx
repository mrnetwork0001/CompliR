import styles from "./page.module.css";

/**
 * 30-day strip chart, inline SVG, no deps. Two lanes with their own scales (never a dual axis):
 *   lane 1  addresses graded per day (ink bars)
 *   lane 2  share of observed USDC volume that touched a flagged wallet (accent line + markers)
 * Days without a stored row are drawn as gaps. Every mark carries a <title> for hover.
 */
export interface StripPoint { date: string; graded: number | null; flaggedShare: number | null; volumeUsdc: number | null; final: boolean }

const W = 920, PAD_L = 44, PAD_R = 12, LANE_H = 92, LANE_GAP = 26, TOP = 16, AXIS_H = 22;
export const STRIP_H = TOP + LANE_H * 2 + LANE_GAP + AXIS_H;

const nice = (max: number) => {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  const m = max / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

export function StripChart({ points }: { points: StripPoint[] }) {
  const n = points.length;
  const innerW = W - PAD_L - PAD_R;
  const slot = innerW / Math.max(n, 1);
  const barW = Math.max(3, Math.min(14, slot * 0.6));
  const x = (i: number) => PAD_L + slot * i + slot / 2;

  const gMax = nice(Math.max(0, ...points.map((p) => p.graded ?? 0)));
  const sMax = nice(Math.max(0.01, ...points.map((p) => p.flaggedShare ?? 0)) * 100) / 100;
  const lane1Y0 = TOP, lane1Y1 = TOP + LANE_H;
  const lane2Y0 = lane1Y1 + LANE_GAP, lane2Y1 = lane2Y0 + LANE_H;
  const gy = (v: number) => lane1Y1 - (v / gMax) * (LANE_H - 10);
  const sy = (v: number) => lane2Y1 - (v / sMax) * (LANE_H - 10);

  const linePts = points.map((p, i) => (p.flaggedShare == null ? null : `${r2(x(i))},${r2(sy(p.flaggedShare))}`));
  const segments: string[] = [];
  let cur: string[] = [];
  for (const pt of linePts) { if (pt) cur.push(pt); else { if (cur.length) segments.push(cur.join(" ")); cur = []; } }
  if (cur.length) segments.push(cur.join(" "));

  const last = points[n - 1];
  const lastGraded = points.map((p, i) => ({ p, i })).filter(({ p }) => p.graded != null).at(-1);
  const peak = points.reduce<{ p: StripPoint; i: number } | null>((acc, p, i) => (p.graded != null && (!acc || p.graded > (acc.p.graded ?? 0)) ? { p, i } : acc), null);
  const tickEvery = n > 20 ? 7 : n > 10 ? 3 : 1;

  return (
    <div className={styles.chartWrap}>
      <svg className={styles.chart} viewBox={`0 0 ${W} ${STRIP_H}`} role="img" aria-label="Addresses graded per day and share of observed USDC volume that touched a flagged wallet, last 30 days">
        {/* lane rules + scale labels */}
        {[lane1Y0, lane1Y1, lane2Y0, lane2Y1].map((y) => <line key={y} className={styles.rule} x1={PAD_L} x2={W - PAD_R} y1={r2(y)} y2={r2(y)} />)}
        <text className={styles.laneLabel} x={PAD_L} y={lane1Y0 - 5}>graded / day</text>
        <text className={styles.scale} x={PAD_L - 6} y={lane1Y0 + 10} textAnchor="end">{gMax}</text>
        <text className={styles.scale} x={PAD_L - 6} y={lane1Y1} textAnchor="end">0</text>
        <text className={styles.laneLabel} x={PAD_L} y={lane2Y0 - 5}>flagged share of observed USDC</text>
        <text className={styles.scale} x={PAD_L - 6} y={lane2Y0 + 10} textAnchor="end">{r2(sMax * 100)}%</text>
        <text className={styles.scale} x={PAD_L - 6} y={lane2Y1} textAnchor="end">0%</text>

        {/* lane 1: bars */}
        {points.map((p, i) => p.graded == null ? (
          <line key={p.date} className={styles.gap} x1={r2(x(i))} x2={r2(x(i))} y1={lane1Y1 - 3} y2={lane1Y1} />
        ) : (
          <g key={p.date}>
            <title>{`${p.date}: ${p.graded} graded${p.final ? "" : " (partial day)"}`}</title>
            <rect className={p.final ? styles.bar : styles.barPartial} x={r2(x(i) - barW / 2)} y={r2(Math.min(gy(p.graded), lane1Y1 - 1))} width={r2(barW)} height={r2(Math.max(1, lane1Y1 - gy(p.graded)))} />
          </g>
        ))}
        {peak && peak.p.graded! > 0 && (
          <text className={styles.readout} x={r2(x(peak.i))} y={r2(gy(peak.p.graded!) - 4)} textAnchor="middle">{peak.p.graded}</text>
        )}

        {/* lane 2: line + markers */}
        {segments.map((d, k) => <polyline key={k} className={styles.line} points={d} />)}
        {points.map((p, i) => p.flaggedShare == null ? null : (
          <g key={p.date}>
            <title>{`${p.date}: ${r2(p.flaggedShare * 100)}% of ${p.volumeUsdc ?? 0} USDC touched a flagged wallet${p.final ? "" : " (partial day)"}`}</title>
            <circle className={styles.marker} cx={r2(x(i))} cy={r2(sy(p.flaggedShare))} r={p.volumeUsdc ? 3 : 2} />
          </g>
        ))}
        {last?.flaggedShare != null && (
          <text className={styles.readoutAcc} x={r2(x(n - 1))} y={r2(sy(last.flaggedShare) - 7)} textAnchor="end">{r2(last.flaggedShare * 100)}%</text>
        )}
        {lastGraded && (
          <line className={styles.cursor} x1={r2(x(lastGraded.i))} x2={r2(x(lastGraded.i))} y1={lane1Y0} y2={lane2Y1} />
        )}

        {/* axis */}
        <line className={styles.axis} x1={PAD_L} x2={W - PAD_R} y1={lane2Y1 + 0.5} y2={lane2Y1 + 0.5} />
        {points.map((p, i) => ((i % tickEvery === 0 && n - 1 - i >= 3) || i === n - 1) && (
          <g key={p.date}>
            <line className={styles.tick} x1={r2(x(i))} x2={r2(x(i))} y1={lane2Y1} y2={lane2Y1 + 4} />
            <text className={styles.axisLabel} x={r2(x(i))} y={lane2Y1 + 15} textAnchor={i === n - 1 ? "end" : i === 0 ? "start" : "middle"}>{p.date.slice(5)}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
