import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { scene, wordAt, lineStart } from "../timing";
import { C, mono, sans } from "../theme";
import { clamp, pop, ramp } from "../ui/motion";
import { Browser, markOf } from "../ui/Footage";
import { Logo } from "../ui/Logo";
import data from "../data.json";

/** The agent-run company: it prices, holds, pays, and refuses. */
export const Company: React.FC = () => {
  const s = scene("company");
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt("company", w, n) - s.from;
  const t2 = lineStart("company", 1) - s.from;
  const swap = interpolate(f, [t2 - 8, t2 + 8], [0, 1], clamp);
  const tRef = rel("refused.");
  const stamp = pop(f, tRef);
  const chips: [React.ReactNode, number][] = [
    [<>{data.price.screenUsdc} USDC / call</>, rel("cent")],
    [<>x402 · Circle facilitator</>, rel("x402.")],
    [<><Logo name="circle" height={22} /> Circle wallets</>, rel("Circle")],
  ];
  const hist = data.price.history;
  const tCut = rel("cut");
  const heldStart = markOf("payouts", "held") - 20;
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: sans, color: C.text }}>
      <div style={{ opacity: 1 - swap }}>
        <Browser name="company" url="trycomplir.xyz/company" width={1280} left={320} top={140} tilt={8} />
      </div>
      <div style={{ opacity: swap }}>
        <Browser name="payouts" url="trycomplir.xyz/payouts" width={1280} left={320} top={140} startFrom={heldStart} focus="held" zoom={1.5} focusAt={[t2 + 30, t2 + 60]} enter={t2 - 8} />
      </div>
      <div style={{ position: "absolute", left: 320, top: 80, display: "flex", gap: 12, opacity: 1 - swap }}>
        {chips.map(([t, at], i) => {
          const p = pop(f, at);
          return <span key={i} style={{ transform: `scale(${p})`, opacity: p, display: "inline-flex", alignItems: "center", gap: 10, padding: "9px 18px", background: C.panel, border: `1px solid ${C.line2}`, fontFamily: mono, fontSize: 18 }}>{t}</span>;
        })}
      </div>
      <div style={{ position: "absolute", right: 120, top: 560, padding: "14px 24px", border: `2px solid ${C.high}`, color: C.high, background: "rgba(10,11,13,0.85)", fontFamily: mono, fontSize: 24, letterSpacing: "0.14em", opacity: stamp, transform: `scale(${0.6 + 0.4 * stamp}) rotate(-3deg)` }}>
        HELD · {data.payouts.heldUsdc} USDC · PAYEE HIGH
        <div style={{ fontSize: 14, letterSpacing: "0.08em", color: C.muted, marginTop: 6 }}>a test invoice we sent to the Ronin wallet</div>
      </div>
      <div style={{ position: "absolute", left: 320, top: 80, display: "flex", alignItems: "center", gap: 16, fontFamily: mono, fontSize: 22, opacity: ramp(f, tCut - 6, tCut + 6) * swap }}>
        <span style={{ color: C.muted, letterSpacing: "0.12em", fontSize: 18 }}>SCREEN PRICE, SET BY THE AGENT</span>
        {hist.map((p, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span style={{ color: C.muted, opacity: ramp(f, tCut + i * 10, tCut + i * 10 + 8) }}>→</span>}
            <span style={{ padding: "6px 14px", border: `1px solid ${i === hist.length - 1 ? C.acc : C.line2}`, color: i === hist.length - 1 ? C.acc : C.text, opacity: ramp(f, tCut + i * 10, tCut + i * 10 + 8) }}>{p}</span>
          </React.Fragment>
        ))}
      </div>
    </AbsoluteFill>
  );
};
