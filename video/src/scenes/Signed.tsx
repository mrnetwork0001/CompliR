import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { scene, wordAt } from "../timing";
import { C, mono, sans } from "../theme";
import { pop, ramp } from "../ui/motion";
import { Browser } from "../ui/Footage";
import { Count } from "../ui/Count";
import { Fig } from "../ui/Fig";
import { Logo } from "../ui/Logo";
import data from "../data.json";

/** Signed, on-chain, replayable; and it keeps watching. */
export const Signed: React.FC = () => {
  const s = scene("signed");
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt("signed", w, n) - s.from;
  const reg = data.registry;
  const rows: [string, React.ReactNode, number][] = [
    ["SIGNED", "EIP-712 attestation, verifiable offline", rel("signed,")],
    ["ON ARC", <>AttestationRegistry · {reg.slice(0, 6)}…{reg.slice(-4)}</>, rel("registry")],
    ["REPLAYABLE", <><Count to={data.ledger.entries} at={rel("ledger")} dur={36} /> ledger entries · chain intact</>, rel("ledger")],
  ];
  const tC = rel("contract");
  const tW = rel("watching.");
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: sans, color: C.text }}>
      <Browser name="ledger" url="trycomplir.xyz/ledger" width={980} left={110} top={170} focus="badge" zoom={1.7} focusAt={[rel("ledger") - 4, rel("ledger") + 30]} unfocusAt={[tW - 10, tW + 14]} tilt={6} />
      <div style={{ position: "absolute", left: 1150, top: 170, width: 660 }}>
        {rows.map(([k, t, at]) => {
          const p = pop(f, at);
          return (
            <div key={k} style={{ opacity: p, transform: `translateX(${(1 - p) * 40}px)`, padding: "16px 0", borderBottom: `1px solid ${C.line2}` }}>
              <div style={{ fontFamily: mono, fontSize: 16, letterSpacing: "0.16em", color: C.acc }}>{k}</div>
              <div style={{ fontSize: 30, marginTop: 6, letterSpacing: "-0.02em" }}>{t}</div>
            </div>
          );
        })}
        <div style={{ marginTop: 26, opacity: ramp(f, tC - 4, tC + 10) }}>
          <Fig label="any contract, one line" meta="solidity">
            <div style={{ fontFamily: mono, fontSize: 21, lineHeight: 1.55, color: C.text }}>
              require(ICompliR(registry)<br />&nbsp;&nbsp;.<span style={{ color: C.acc }}>isAllowed</span>(payee, Tier.MEDIUM));
            </div>
          </Fig>
        </div>
      </div>
      <div style={{ position: "absolute", left: 110, top: 800, display: "flex", alignItems: "center", gap: 18, padding: "16px 22px", background: C.panel, border: `1px solid ${C.line2}`, opacity: ramp(f, tW - 6, tW + 8) }}>
        <Logo name="circle" height={34} />
        <span style={{ fontFamily: mono, fontSize: 21, letterSpacing: "0.04em" }}>USDC <span style={{ color: C.high }}>Blacklisted</span>(wallet) on Arc</span>
        <span style={{ fontFamily: mono, fontSize: 21, color: C.muted }}>→</span>
        <span style={{ fontFamily: mono, fontSize: 21, color: C.acc, opacity: ramp(f, rel("minute.") - 6, rel("minute.") + 6) }}>re-graded &lt; 1 min · webhook sent</span>
      </div>
    </AbsoluteFill>
  );
};
