import React from "react";
import { AbsoluteFill } from "remotion";
import { C, mono, sans, serif } from "./theme";
import { Mark } from "./ui/Mark";
import { Logo } from "./ui/Logo";
import { Grain } from "./ui/Grain";

/** 1920x1080 thumbnail. */
export const Poster: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg, color: C.text, fontFamily: sans }}>
    <AbsoluteFill style={{ background: "radial-gradient(45% 50% at 30% 45%, rgba(63,224,200,0.16), transparent 75%)" }} />
    <div style={{ position: "absolute", left: 140, top: 150, display: "flex", alignItems: "center", gap: 36 }}>
      <Mark size={150} />
      <Logo name="wordmark" height={84} />
    </div>
    <div style={{ position: "absolute", left: 140, top: 420, fontSize: 132, fontWeight: 400, letterSpacing: "-0.05em", lineHeight: 1 }}>
      Screen before<br />you <span style={{ fontFamily: serif, fontStyle: "italic", color: C.acc, fontSize: "1.15em" }}>pay.</span>
    </div>
    <div style={{ position: "absolute", left: 140, top: 760, fontFamily: mono, fontSize: 26, color: C.muted, letterSpacing: "0.04em" }}>A signed risk verdict for every USDC payment on Arc.</div>
    <div style={{ position: "absolute", left: 140, bottom: 110, display: "flex", alignItems: "center", gap: 50 }}>
      <span style={{ fontFamily: mono, fontSize: 18, letterSpacing: "0.18em", color: C.muted }}>BUILT ON</span>
      <Logo name="arc" height={46} /><span style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 36, fontWeight: 500 }}><Logo name="usdc" height={50} />USDC</span><span style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 36, fontWeight: 500 }}><Logo name="circle" height={50} />Circle</span>
    </div>
    <div style={{ position: "absolute", right: 140, bottom: 116, fontFamily: mono, fontSize: 24, color: C.acc }}>trycomplir.xyz</div>
    <Grain opacity={0.05} />
  </AbsoluteFill>
);
