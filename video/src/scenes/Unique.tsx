import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { scene, wordAt } from "../timing";
import { C, mono, sans } from "../theme";
import { ramp } from "../ui/motion";
import { Words } from "../ui/Words";
import data from "../data.json";

/** Three claims, each with its proof, on full-bleed cyan. */
export const Unique: React.FC = () => {
  const s = scene("unique");
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt("unique", w, n) - s.from;
  const rows: { at: number; text: string; acc: Record<string, string>; proof: React.ReactNode }[] = [
    { at: rel("Graded,"), text: "Graded, not yes or no.", acc: { "graded,": C.accInk }, proof: <>LOW · MEDIUM · HIGH, with limits and reasons</> },
    { at: rel("Signed,"), text: "Signed, not taken on trust.", acc: { "signed,": C.accInk }, proof: <>EIP-712 · registry on Arc · {data.ledger.entries.toLocaleString("en-US")}-entry public ledger</> },
    { at: rel("run"), text: "Run by an agent, in public.", acc: { "agent,": C.accInk }, proof: <>it prices, pays and refuses on its own</> },
  ];
  return (
    <AbsoluteFill style={{ background: C.acc, color: C.accInk, fontFamily: sans }}>
      <div style={{ position: "absolute", left: 150, top: 150, fontSize: 40, fontWeight: 400, letterSpacing: "-0.02em", color: "rgba(6,33,29,0.7)" }}>
        <Words text="What makes it different?" at={0} every={3} accent={{ "different?": C.accInk }} />
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ position: "absolute", left: 150, top: 290 + i * 210, display: "grid", gridTemplateColumns: "90px 1fr", alignItems: "baseline" }}>
          <div style={{ fontFamily: mono, fontSize: 20, opacity: ramp(f, r.at - 6, r.at + 6) }}>0{i + 1}</div>
          <div>
            <div style={{ fontSize: 86, fontWeight: 400, letterSpacing: "-0.045em", lineHeight: 1.05 }}>
              <Words text={r.text} at={r.at - 4} every={3} accent={r.acc} />
            </div>
            <div style={{ marginTop: 10, fontFamily: mono, fontSize: 21, letterSpacing: "0.04em", color: "rgba(6,33,29,0.7)", opacity: ramp(f, r.at + 10, r.at + 26) }}>{r.proof}</div>
          </div>
        </div>
      ))}
    </AbsoluteFill>
  );
};
