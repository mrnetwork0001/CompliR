import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { scene, wordAt } from "../timing";
import { C, sans } from "../theme";
import { clamp, expo } from "../ui/motion";
import { Mark } from "../ui/Mark";
import { Logo } from "../ui/Logo";
import { Scale } from "../ui/Scale";
import { Words } from "../ui/Words";

/** The mark steps in, the wordmark wipes on, the scale draws under the line. */
export const Turn: React.FC = () => {
  const s = scene("turn");
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt("turn", w, n) - s.from;
  const tName = rel("CompliR.");
  const p = interpolate(f, [rel("Meet") - 4, tName + 14], [0, 1], clamp);
  const word = interpolate(f, [tName - 2, tName + 16], [0, 1], { ...clamp, easing: expo });
  return (
    <AbsoluteFill style={{ background: C.bg, color: C.text, fontFamily: sans }}>
      <AbsoluteFill style={{ background: "radial-gradient(40% 45% at 50% 42%, rgba(63,224,200,0.12), transparent 75%)" }} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", transform: "translateY(-90px)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 46 }}>
          <Mark size={168} p={p} />
          <div style={{ clipPath: `inset(0 ${(1 - word) * 100}% 0 0)`, opacity: word }}><Logo name="wordmark" height={96} /></div>
        </div>
      </AbsoluteFill>
      <div style={{ position: "absolute", left: 0, right: 0, top: 640, textAlign: "center", fontSize: 76, fontWeight: 300, letterSpacing: "-0.035em" }}>
        <Words text="Screen before you pay." at={rel("Screen")} every={3} accent={{ "pay.": C.acc }} serifScale={1.2} />
      </div>
      <div style={{ position: "absolute", left: 560, top: 780 }}>
        <Scale width={800} drawAt={rel("Screen") + 4} showLabels={false} />
      </div>
    </AbsoluteFill>
  );
};
