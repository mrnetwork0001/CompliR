import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { scene, wordAt } from "../timing";
import { C, mono, sans } from "../theme";
import { clamp, expo, pop, ramp } from "../ui/motion";
import { Count } from "../ui/Count";
import { Words } from "../ui/Words";
import { Logo } from "../ui/Logo";
import data from "../data.json";

/** Cold open: the Ronin bridge drain, the wallet that took it, and the fact it can still be paid. */
export const Open: React.FC = () => {
  const s = scene("open");
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt("open", w, n) - s.from;
  const addr = data.ronin.address;
  const tAddr = rel("wallet");
  const typed = Math.floor(interpolate(f, [tAddr, tAddr + 34], [0, addr.length], clamp));
  const tSanc = rel("sanctions");
  const stamp = pop(f, tSanc);
  const tAny = rel("Anyone");
  const coin = interpolate(f, [tAny, tAny + 34], [0, 1], { ...clamp, easing: expo });
  const lift = interpolate(f, [tAddr - 10, tAddr + 8], [0, -150], { ...clamp, easing: expo });
  const firstOut = interpolate(f, [tAddr - 10, tAddr + 6], [1, 0.28], clamp);
  return (
    <AbsoluteFill style={{ background: C.bg, color: C.text, fontFamily: sans }}>
      <AbsoluteFill style={{ background: "radial-gradient(50% 55% at 50% 48%, rgba(248,113,113,0.08), transparent 70%)" }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 300, textAlign: "center", transform: `translateY(${lift}px)`, opacity: firstOut }}>
        <div style={{ fontFamily: mono, fontSize: 20, letterSpacing: "0.22em", color: C.muted, opacity: ramp(f, 4, 20) }}>MARCH 2022 · RONIN BRIDGE</div>
        <div style={{ marginTop: 22, fontSize: 168, fontWeight: 500, letterSpacing: "-0.05em", lineHeight: 1 }}>
          <Count to={625} at={rel("six")} dur={34} prefix="$" suffix="M" style={{ opacity: ramp(f, rel("six") - 4, rel("six") + 6) }} />
        </div>
        <div style={{ marginTop: 16, fontSize: 40, fontWeight: 300, color: C.muted, letterSpacing: "-0.02em" }}>
          <Words text="drained from the Ronin bridge" at={rel("drain")} every={3} accent={{ "ronin": C.high }} />
        </div>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 520, textAlign: "center", opacity: ramp(f, tAddr - 4, tAddr + 6) }}>
        <div style={{ fontFamily: mono, fontSize: 18, letterSpacing: "0.2em", color: C.muted, marginBottom: 18 }}>THE WALLET THAT TOOK IT</div>
        <div style={{ fontFamily: mono, fontSize: 46, letterSpacing: "0.02em", color: C.text }}>
          {addr.slice(0, typed)}<span style={{ opacity: typed < addr.length && f % 16 < 8 ? 1 : 0, color: C.acc }}>▍</span>
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 14, marginTop: 34, padding: "12px 22px", border: `2px solid ${C.high}`, color: C.high, fontFamily: mono, fontSize: 22, letterSpacing: "0.16em",
          transform: `scale(${0.6 + 0.4 * stamp}) rotate(${-4 * stamp}deg)`, opacity: stamp }}>
          OFAC SDN LIST · SANCTIONED · APR 2022
        </div>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 800, display: "flex", justifyContent: "center", alignItems: "center", gap: 22, opacity: ramp(f, tAny - 4, tAny + 8) }}>
        <div style={{ transform: `translateX(${(coin - 1) * 220}px)` }}><Logo name="usdc" height={58} /></div>
        <div style={{ width: 300 * coin, height: 2, background: `linear-gradient(90deg, ${C.usdc}, ${C.high})` }} />
        <div style={{ fontFamily: mono, fontSize: 22, color: C.muted, letterSpacing: "0.08em", opacity: ramp(f, tAny + 24, tAny + 36) }}>0x098b…2f96 · nothing stops it</div>
      </div>
    </AbsoluteFill>
  );
};
