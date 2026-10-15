import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { scene, wordAt } from "../timing";
import { C, mono, sans } from "../theme";
import { pop } from "../ui/motion";
import { Browser, markOf } from "../ui/Footage";
import { Logo } from "../ui/Logo";

const START = 40; // footage frame the scene opens on (just before the typing)

/** The real check: the Ronin address typed into the live site, the agents at work. */
export const Check: React.FC = () => {
  const s = scene("check");
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt("check", w, n) - s.from;
  const submit = markOf("check", "submit") - START;
  const chips: [React.ReactNode, number][] = [
    [<>sanctions lists · OFAC, EU, UK, UN</>, rel("sanctions")],
    [<><Logo name="circle" height={24} /> Circle USDC blocklist</>, rel("Circle's")],
    [<>funders · two hops back</>, rel("two")],
  ];
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: sans }}>
      <AbsoluteFill style={{ background: "radial-gradient(60% 60% at 50% 40%, rgba(63,224,200,0.07), transparent 70%)" }} />
      <Browser name="check" url="trycomplir.xyz/check" width={1280} left={320} top={140} startFrom={START} focus="modal" zoom={1.55} focusAt={[submit + 20, submit + 50]} tilt={8} />
      <div style={{ position: "absolute", left: 320, top: 80, display: "flex", gap: 12 }}>
        {chips.map(([t, at], i) => {
          const p = pop(f, at);
          return <span key={i} style={{ transform: `scale(${p})`, opacity: p, display: "inline-flex", alignItems: "center", gap: 10, padding: "9px 18px", background: C.panel, border: `1px solid ${C.line2}`, color: C.text, fontFamily: mono, fontSize: 18, letterSpacing: "0.03em" }}>{t}</span>;
        })}
      </div>
    </AbsoluteFill>
  );
};
