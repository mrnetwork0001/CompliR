import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { scene, wordAt } from "../timing";
import { C, mono, sans } from "../theme";
import { pop, ramp } from "../ui/motion";
import { Browser, markOf } from "../ui/Footage";
import { Fig } from "../ui/Fig";

/** One prompt wires it in; the first live integration. */
export const Integrate: React.FC = () => {
  const s = scene("integrate");
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt("integrate", w, n) - s.from;
  const tInk = rel("Inktoll,");
  const p = pop(f, tInk);
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: sans, color: C.text }}>
      <Browser name="prompt" url="trycomplir.xyz/docs/agent-prompt" width={1180} left={110} top={150} startFrom={markOf("prompt", "copy") - 40} tilt={8} />
      <div style={{ position: "absolute", left: 1340, top: 190, width: 470, fontFamily: mono, fontSize: 20, lineHeight: 1.7, color: C.muted, opacity: ramp(f, rel("paste") - 4, rel("paste") + 10) }}>
        <div style={{ color: C.acc, letterSpacing: "0.14em", fontSize: 16 }}>PASTE INTO</div>
        <div style={{ color: C.text, fontSize: 30, fontFamily: sans, letterSpacing: "-0.02em", lineHeight: 1.3, marginTop: 6 }}>Claude Code, Cursor, Codex</div>
        <div style={{ marginTop: 18 }}>finds the money flows · adds one check · blocks HIGH · caps MEDIUM · retries · tests</div>
      </div>
      <div style={{ position: "absolute", left: 1340, top: 560, width: 470, opacity: p, transform: `scale(${0.85 + 0.15 * p})`, transformOrigin: "left top" }}>
        <Fig label="first integration" meta="live">
          <div style={{ fontSize: 46, fontWeight: 500, letterSpacing: "-0.03em" }}>Inktoll</div>
          <div style={{ fontFamily: mono, fontSize: 17, color: C.muted, marginTop: 8, lineHeight: 1.6 }}>our sister project · x402 marketplace on Arc<br />screens every payout · paid in real USDC</div>
        </Fig>
      </div>
    </AbsoluteFill>
  );
};
