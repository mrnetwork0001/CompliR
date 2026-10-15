import React from "react";
import { interpolate } from "remotion";
import { C } from "../theme";
import { clamp, expo } from "./motion";

/**
 * The CompliR mark, redrawn from public/brand/mark.png: three squares stepping down a
 * two-column grid (teal top-left, white middle-right, bright cyan bottom-left), each with a
 * soft glow. `p` 0..1 drops them in turn.
 */
export const Mark: React.FC<{ size: number; p?: number }> = ({ size, p = 1 }) => {
  const sq = [
    { x: 0, y: 0, c: "#14b8a6", a: [0, 0.4] },
    { x: 1, y: 1, c: "#f4f4f2", a: [0.25, 0.65] },
    { x: 0, y: 2, c: "#22f2dc", a: [0.5, 0.95] },
  ];
  const u = size / 3;
  return (
    <div style={{ position: "relative", width: u * 2, height: size }}>
      {sq.map((s, i) => {
        const k = interpolate(p, s.a, [0, 1], { ...clamp, easing: expo });
        return (
          <div key={i} style={{
            position: "absolute", left: s.x * u, top: s.y * u - (1 - k) * u * 0.6, width: u, height: u, background: s.c, opacity: k,
            boxShadow: `0 0 ${u * 0.45}px ${s.c === "#f4f4f2" ? "rgba(255,255,255,0.25)" : "rgba(63,224,200,0.55)"}`,
          }} />
        );
      })}
    </div>
  );
};

export const ACC = C.acc;
