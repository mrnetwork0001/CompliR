import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { scene, wordAt } from "../timing";
import { C, mono, sans } from "../theme";
import { clamp, pop, ramp } from "../ui/motion";
import { Fig } from "../ui/Fig";
import { Words } from "../ui/Words";
import { Logo } from "../ui/Logo";

/** An agent about to pay an address it cannot read; the checks that exist answer yes or no. */
export const Problem: React.FC = () => {
  const s = scene("problem");
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt("problem", w, n) - s.from;
  const tVendor = rel("vendor");
  const tLaund = rel("launderer.");
  const flip = f >= tLaund ? 1 : 0;
  const q = pop(f, tVendor);
  const chips: [string, number][] = [["one wallet", rel("one")], ["once", rel("once,")], ["yes / no", rel("yes")]];
  const dim = interpolate(f, [rel("And") - 6, rel("And") + 10], [1, 0.35], clamp);
  return (
    <AbsoluteFill style={{ background: C.paper, color: C.ink, fontFamily: sans }}>
      <div style={{ position: "absolute", left: 150, top: 150, fontSize: 64, fontWeight: 400, letterSpacing: "-0.04em", lineHeight: 1.1, width: 820 }}>
        <Words text="Now AI agents pay in USDC." at={4} every={3} accent={{ "usdc.": C.usdc }} />
      </div>
      <div style={{ position: "absolute", left: 150, top: 330, opacity: dim }}>
        <Fig light label="agent · payout" meta="arc mainnet" style={{ width: 760, opacity: ramp(f, rel("sees") - 6, rel("sees") + 8) }}>
          <div style={{ fontFamily: mono, fontSize: 26, lineHeight: 1.7, color: C.ink }}>
            <div><span style={{ color: C.inkMuted }}>await</span> usdc.transfer(</div>
            <div style={{ paddingLeft: 36 }}>to: <span style={{ background: "rgba(39,117,202,0.12)", padding: "2px 8px" }}>0x098b716b…2f96</span>,</div>
            <div style={{ paddingLeft: 36, display: "flex", alignItems: "center", gap: 12 }}>token: <Logo name="usdc" height={28} /> USDC</div>
            <div>)</div>
          </div>
        </Fig>
      </div>
      <div style={{ position: "absolute", left: 1010, top: 410, width: 760, opacity: q * dim, transform: `scale(${0.8 + 0.2 * q})`, transformOrigin: "left center" }}>
        <div style={{ fontFamily: mono, fontSize: 20, letterSpacing: "0.16em", color: C.inkMuted }}>WHO IS THIS?</div>
        <div style={{ fontSize: 120, fontWeight: 500, letterSpacing: "-0.05em", lineHeight: 1.05, marginTop: 10 }}>
          <span style={{ opacity: flip ? 0.25 : 1 }}>vendor</span><span style={{ color: C.inkMuted }}>?</span>
        </div>
        <div style={{ fontSize: 120, fontWeight: 500, letterSpacing: "-0.05em", lineHeight: 1.05, color: flip ? C.high : "rgba(13,15,18,0.15)" }}>
          launderer<span style={{ color: C.inkMuted }}>?</span>
        </div>
      </div>
      <div style={{ position: "absolute", left: 150, top: 790, display: "flex", gap: 18, alignItems: "center" }}>
        <span style={{ fontFamily: mono, fontSize: 20, letterSpacing: "0.14em", color: C.inkMuted, opacity: ramp(f, rel("checks") - 4, rel("checks") + 8) }}>TODAY'S CHECKS:</span>
        {chips.map(([t, at]) => {
          const p = pop(f, at);
          return <span key={t} style={{ transform: `scale(${p})`, opacity: p, padding: "12px 22px", background: C.ink, color: C.paper, fontFamily: mono, fontSize: 24, letterSpacing: "0.04em" }}>{t}</span>;
        })}
      </div>
    </AbsoluteFill>
  );
};
