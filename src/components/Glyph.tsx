/**
 * Glyph — CompliR's own status marks, drawn on the same 4-square pixel grid as the wordmark.
 * Use instead of emoji / dingbats. Monochrome; colour comes from `currentColor` or the `tone` prop.
 */
import type { CSSProperties } from "react";

type Tone = "acc" | "low" | "medium" | "high" | "muted" | "current";
const TONE: Record<Tone, string> = { acc: "var(--acc)", low: "var(--low)", medium: "var(--medium)", high: "var(--high)", muted: "var(--faint)", current: "currentColor" };

export type GlyphName = "check" | "hold" | "limit" | "alert" | "dot";

/** 4×4 pixel grid, each cell 3 units with 1 unit gaps (viewBox 0 0 15 15). */
const CELLS: Record<GlyphName, [number, number][]> = {
  check: [[0, 2], [1, 3], [2, 2], [3, 1], [3, 0]].map(([x, y]) => [x, 3 - y] as [number, number]),
  hold:  [[0, 1], [0, 2], [3, 1], [3, 2]],                          // two bars = paused/held
  limit: [[0, 3], [1, 2], [2, 2], [3, 3], [1, 0], [2, 0]],          // capped bracket
  alert: [[1, 0], [2, 0], [1, 1], [2, 1], [1, 3], [2, 3]],          // exclamation
  dot:   [[1, 1], [2, 1], [1, 2], [2, 2]],                          // live dot
};

export function Glyph({ name, size = 14, tone = "current", title, style }: { name: GlyphName; size?: number; tone?: Tone; title?: string; style?: CSSProperties }) {
  const fill = TONE[tone];
  return (
    <svg viewBox="0 0 15 15" width={size} height={size} role={title ? "img" : undefined} aria-hidden={title ? undefined : true} style={{ display: "inline-block", verticalAlign: "-0.15em", flex: "none", ...style }}>
      {title && <title>{title}</title>}
      {CELLS[name].map(([x, y]) => (
        <rect key={`${x}${y}`} x={x * 4} y={y * 4} width={3} height={3} fill={fill} />
      ))}
    </svg>
  );
}
