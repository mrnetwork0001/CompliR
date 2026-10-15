import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C, mono } from "../theme";
import { clamp, expo } from "./motion";

/**
 * The film's motif: CompliR's grading scale. A measuring rule (0..100, ticks every point, major
 * every ten) with the three tier bands under it, drawn left to right from `drawAt`, and a cursor
 * that travels from 0 to `value` between `moveAt` and `moveAt + 30`.
 */
export const Scale: React.FC<{ width: number; drawAt: number; moveAt?: number; value?: number; light?: boolean; showLabels?: boolean }> = ({ width, drawAt, moveAt, value, light, showLabels = true }) => {
  const f = useCurrentFrame();
  const draw = interpolate(f, [drawAt, drawAt + 26], [0, 1], { ...clamp, easing: expo });
  const ink = light ? C.ink : C.text;
  const minor = light ? "rgba(13,15,18,0.25)" : "rgba(236,237,238,0.28)";
  const v = moveAt != null && value != null ? interpolate(f, [moveAt, moveAt + 30], [0, value], { ...clamp, easing: expo }) : null;
  const tier = v == null ? null : v > 60 ? "HIGH" : v > 20 ? "MEDIUM" : "LOW";
  const tc = tier ? (tier === "HIGH" ? C.high : tier === "MEDIUM" ? C.medium : C.low) : C.acc;
  const bands: [number, number, string, string][] = [[0, 20, C.low, "LOW 0-20"], [21, 60, C.medium, "MEDIUM 21-60"], [61, 100, C.high, "HIGH 61-100"]];
  return (
    <div style={{ position: "relative", width, height: 96, clipPath: `inset(0 ${(1 - draw) * 100}% -40px 0)` }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 24, height: 18,
        backgroundImage: `repeating-linear-gradient(to right, ${minor} 0 1px, transparent 1px ${width / 100}px), repeating-linear-gradient(to right, ${ink} 0 1px, transparent 1px ${width / 10}px)`,
        backgroundSize: `100% 9px, 100% 18px`, backgroundRepeat: "no-repeat" }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 42, height: 1, background: minor }} />
      {bands.map(([a, b, col, lab]) => (
        <div key={lab} style={{ position: "absolute", left: (a / 100) * width, width: ((b - a) / 100) * width, top: 50, height: 4, background: col, opacity: tier && lab.startsWith(tier) ? 1 : 0.55 }}>
          {showLabels && <div style={{ position: "absolute", top: 12, left: 0, fontFamily: mono, fontSize: 14, letterSpacing: "0.1em", color: tier && lab.startsWith(tier) ? col : light ? C.inkMuted : C.muted }}>{lab}</div>}
        </div>
      ))}
      {v != null && (
        <div style={{ position: "absolute", left: (v / 100) * width, top: 0, height: 58, width: 2, marginLeft: -1, background: tc, boxShadow: `0 0 14px ${tc}` }}>
          <div style={{ position: "absolute", bottom: 60, left: -36, width: 72, textAlign: "center", fontFamily: mono, fontSize: 18, color: tc, fontVariantNumeric: "tabular-nums" }}>{Math.round(v)}</div>
        </div>
      )}
    </div>
  );
};
