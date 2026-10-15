import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { scene, wordAt, lineStart } from "../timing";
import { C, mono, sans } from "../theme";
import { clamp, expo, pop, ramp } from "../ui/motion";
import { Browser, markOf } from "../ui/Footage";
import { Fig } from "../ui/Fig";
import { Scale } from "../ui/Scale";
import data from "../data.json";

/** The signed verdict lands; then who decides what: rules own the score, the analyst only the limits. */
export const Verdict: React.FC = () => {
  const s = scene("verdict");
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt("verdict", w, n) - s.from;
  const START = markOf("check", "verdict") - 12;
  const t2 = lineStart("verdict", 1) - s.from;
  const slide = interpolate(f, [t2 - 10, t2 + 16], [0, 1], { ...clamp, easing: expo });
  const v = data.verdict;
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: sans, color: C.text }}>
      <Browser name="check" url="trycomplir.xyz/check" width={1280 - 460 * slide} left={320 - 220 * slide} top={140 + 120 * slide} startFrom={START} freezeAt={markOf("check", "verdict") + 80} focus="result" zoom={1.5} focusAt={[0, 1]} />
      <div style={{ position: "absolute", left: 1010, top: 170, width: 790, opacity: slide, transform: `translateX(${(1 - slide) * 60}px)` }}>
        <Fig label="the grade" meta={<span style={{ color: C.high }}>{v.tier} · {v.score}</span>}>
          <div style={{ paddingTop: 40 }}><Scale width={740} drawAt={t2} moveAt={rel("score.")} value={v.score} /></div>
        </Fig>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginTop: 22 }}>
          {[
            ["RULES", "set the score", rel("Fixed"), C.acc],
            ["AI ANALYST", "sets limits · writes the reason", rel("analyst"), C.text],
          ].map(([k, t, at, col]) => {
            const p = pop(f, at as number);
            return (
              <div key={k as string} style={{ opacity: p, transform: `scale(${0.85 + 0.15 * p})`, padding: "18px 20px", border: `1px solid ${C.line2}`, background: C.panel }}>
                <div style={{ fontFamily: mono, fontSize: 16, letterSpacing: "0.14em", color: col as string }}>{k}</div>
                <div style={{ fontSize: 28, marginTop: 8, letterSpacing: "-0.02em" }}>{t}</div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 22, display: "flex", alignItems: "center", gap: 14, fontFamily: mono, fontSize: 20, letterSpacing: "0.06em", color: C.muted, opacity: ramp(f, rel("never") - 4, rel("never") + 8) }}>
          <span style={{ width: 22, height: 22, border: `2px solid ${C.acc}`, display: "inline-block" }} />
          the analyst's output is clamped in code. limits for this wallet: {v.limits.maxPerTxUsdc} / {v.limits.maxPerDayUsdc} USDC
        </div>
      </div>
    </AbsoluteFill>
  );
};
