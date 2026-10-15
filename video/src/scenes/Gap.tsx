import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { scene, wordAt } from "../timing";
import { C, mono, sans } from "../theme";
import { clamp, expo, ramp } from "../ui/motion";
import { Words } from "../ui/Words";

/** What nobody can do today. */
export const Gap: React.FC = () => {
  const s = scene("gap");
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt("gap", w, n) - s.from;
  const rows: [string, number][] = [
    ["Nothing grades the counterparty.", rel("grades")],
    ["Nothing keeps watching it.", rel("watching")],
    ["No contract can check the answer.", rel("contract")],
  ];
  return (
    <AbsoluteFill style={{ background: C.paper, color: C.ink, fontFamily: sans }}>
      <div style={{ position: "absolute", left: 150, top: 170, fontSize: 92, fontWeight: 400, letterSpacing: "-0.05em", lineHeight: 1.08 }}>
        <div><Words text="Money moves at machine speed." at={0} every={3} /></div>
        <div style={{ color: C.inkMuted }}><Words text="Risk checks don't." at={rel("Risk")} every={3} accent={{ "don't.": C.high }} serifScale={1.15} /></div>
      </div>
      <div style={{ position: "absolute", left: 150, top: 560 }}>
        {rows.map(([t, at], i) => {
          const p = ramp(f, at - 6, at + 8);
          const strike = interpolate(f, [at + 10, at + 24], [0, 1], { ...clamp, easing: expo });
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 24, marginBottom: 26, opacity: p, transform: `translateX(${(1 - p) * -30}px)` }}>
              <span style={{ fontFamily: mono, fontSize: 30, color: C.high, width: 36 }}>×</span>
              <span style={{ position: "relative", fontSize: 50, fontWeight: 400, letterSpacing: "-0.03em" }}>
                {t}
                <span style={{ position: "absolute", left: 0, top: "55%", height: 3, width: `${strike * 100}%`, background: "rgba(13,15,18,0.0)" }} />
              </span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
