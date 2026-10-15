import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { scene, wordAt } from "../timing";
import { C, mono, sans } from "../theme";
import { clamp, expo, pop, ramp } from "../ui/motion";
import { Mark } from "../ui/Mark";
import { Logo } from "../ui/Logo";
import { Scale } from "../ui/Scale";
import { Words } from "../ui/Words";

/** Logo, the stack it is built on, the line, the URL. */
export const Close: React.FC = () => {
  const s = scene("close");
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt("close", w, n) - s.from;
  const p = interpolate(f, [0, 22], [0, 1], clamp);
  const word = interpolate(f, [4, 22], [0, 1], { ...clamp, easing: expo });
  const logos: ["arc" | "usdc" | "circle", number, number][] = [["arc", rel("Arc,"), 52], ["usdc", rel("USDC"), 58], ["circle", rel("Circle."), 58]];
  return (
    <AbsoluteFill style={{ background: C.bg, color: C.text, fontFamily: sans }}>
      <AbsoluteFill style={{ background: "radial-gradient(45% 45% at 50% 40%, rgba(63,224,200,0.12), transparent 75%)" }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 200, display: "flex", justifyContent: "center", alignItems: "center", gap: 40 }}>
        <Mark size={132} p={p} />
        <div style={{ clipPath: `inset(0 ${(1 - word) * 100}% 0 0)` }}><Logo name="wordmark" height={76} /></div>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 420, display: "flex", justifyContent: "center", alignItems: "center", gap: 56 }}>
        <span style={{ fontFamily: mono, fontSize: 18, letterSpacing: "0.18em", color: C.muted, opacity: ramp(f, rel("Built") - 4, rel("Built") + 8) }}>BUILT ON</span>
        {logos.map(([n, at, h]) => {
          const k = pop(f, at);
          return <div key={n} style={{ opacity: k, transform: `scale(${0.7 + 0.3 * k})`, display: "flex", alignItems: "center", gap: 14 }}><Logo name={n} height={h} />{n !== "arc" && <span style={{ fontSize: 40, fontWeight: 500, letterSpacing: "-0.02em" }}>{n === "usdc" ? "USDC" : "Circle"}</span>}</div>;
        })}
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 560, textAlign: "center", fontSize: 84, fontWeight: 300, letterSpacing: "-0.04em" }}>
        <Words text="Screen before you pay." at={rel("Screen")} every={3} accent={{ "pay.": C.acc }} serifScale={1.2} />
      </div>
      <div style={{ position: "absolute", left: 560, top: 690 }}><Scale width={800} drawAt={rel("Screen") + 6} showLabels={false} /></div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 840, textAlign: "center", fontFamily: mono, fontSize: 26, letterSpacing: "0.06em", color: C.acc, opacity: ramp(f, rel("pay.") + 8, rel("pay.") + 22) }}>
        trycomplir.xyz
        <div style={{ fontSize: 15, letterSpacing: "0.14em", color: C.muted, marginTop: 12 }}>LIVE ON ARC MAINNET · TAMEION AGENTS HACKATHON</div>
      </div>
    </AbsoluteFill>
  );
};
