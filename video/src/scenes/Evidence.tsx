import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { scene, wordAt } from "../timing";
import { C, mono, sans } from "../theme";
import { clamp, expo, ramp } from "../ui/motion";
import { Count } from "../ui/Count";
import data from "../data.json";

/** Full-bleed cyan: one real day on Arc, from CompliR's signed risk dataset. */
export const Evidence: React.FC = () => {
  const s = scene("evidence");
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt("evidence", w, n) - s.from;
  const d = data.dataset;
  const tBar = rel("half");
  const total = d.byTier.LOW + d.byTier.MEDIUM + d.byTier.HIGH;
  const grow = interpolate(f, [tBar - 4, tBar + 26], [0, 1], { ...clamp, easing: expo });
  const segs: [string, number, string][] = [["LOW", d.byTier.LOW, "rgba(6,33,29,0.25)"], ["MEDIUM", d.byTier.MEDIUM, C.accInk], ["HIGH", d.byTier.HIGH, C.high]];
  const share = Math.round((d.byTier.MEDIUM / total) * 100);
  return (
    <AbsoluteFill style={{ background: C.acc, color: C.accInk, fontFamily: sans }}>
      <div style={{ position: "absolute", left: 150, top: 140, fontFamily: mono, fontSize: 19, letterSpacing: "0.16em" }}>
        COMPLIR RISK DATASET · ARC MAINNET · 14 OCT 2026 · SIGNED SNAPSHOT 23:51 UTC
      </div>
      <div style={{ position: "absolute", left: 150, top: 220, display: "flex", gap: 120, alignItems: "flex-end" }}>
        <div style={{ opacity: ramp(f, rel("hundred") - 6, rel("hundred") + 6) }}>
          <div style={{ fontSize: 150, fontWeight: 500, letterSpacing: "-0.05em", lineHeight: 1 }}>
            <Count to={d.volumeUsdc / 1e6} at={rel("hundred")} dur={40} suffix="M" />
          </div>
          <div style={{ fontFamily: mono, fontSize: 22, letterSpacing: "0.1em", marginTop: 12 }}>USDC MOVED IN ONE DAY</div>
        </div>
        <div style={{ opacity: ramp(f, rel("nearly") - 6, rel("nearly") + 6) }}>
          <div style={{ fontSize: 110, fontWeight: 400, letterSpacing: "-0.05em", lineHeight: 1 }}>
            <Count to={d.transfers} at={rel("nearly")} dur={34} />
          </div>
          <div style={{ fontFamily: mono, fontSize: 22, letterSpacing: "0.1em", marginTop: 12 }}>TRANSFERS</div>
        </div>
      </div>
      <div style={{ position: "absolute", left: 150, top: 560, width: 1620, opacity: ramp(f, rel("seven") - 6, rel("seven") + 6) }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 24 }}>
          <span style={{ fontSize: 96, fontWeight: 500, letterSpacing: "-0.05em" }}><Count to={d.graded} at={rel("seven")} dur={30} /></span>
          <span style={{ fontFamily: mono, fontSize: 22, letterSpacing: "0.1em" }}>WALLETS GRADED</span>
        </div>
        <div style={{ display: "flex", height: 54, marginTop: 26, width: `${grow * 100}%` }}>
          {segs.map(([k, n, col]) => (
            <div key={k} style={{ flex: Math.max(n, 6), background: col, position: "relative" }}>
              <div style={{ position: "absolute", top: 66, left: 0, fontFamily: mono, fontSize: 19, letterSpacing: "0.08em", whiteSpace: "nowrap", opacity: ramp(f, tBar + 18, tBar + 30) }}>{k} {n}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 92, fontSize: 52, fontWeight: 400, letterSpacing: "-0.03em", opacity: ramp(f, tBar + 10, tBar + 24) }}>
          {share}% came back <span style={{ fontWeight: 600 }}>“pay up to a limit”</span>.
        </div>
      </div>
    </AbsoluteFill>
  );
};
