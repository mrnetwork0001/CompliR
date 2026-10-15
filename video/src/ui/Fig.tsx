import React from "react";
import { C, mono } from "../theme";

/**
 * The site's instrument panel (.fig): no full border, four corner brackets, a scale rule
 * across the top edge (ticks every 8px, major every 40px), and a mono head label.
 */
export const Fig: React.FC<{ label?: string; meta?: React.ReactNode; light?: boolean; style?: React.CSSProperties; children?: React.ReactNode; dot?: string }> = ({ label, meta, light, style, children, dot }) => {
  const mark = light ? "rgba(13,15,18,0.5)" : "rgba(236,237,238,0.55)";
  const minor = light ? "rgba(13,15,18,0.16)" : C.line2;
  const major = light ? "rgba(13,15,18,0.3)" : "rgba(236,237,238,0.28)";
  const m = 14, x = 22;
  return (
    <div style={{
      position: "relative", padding: `22px ${x}px ${x}px`, borderRadius: 2,
      backgroundColor: light ? "rgba(255,255,255,0.86)" : "rgba(18,20,24,0.94)",
      backgroundImage: [
        `repeating-linear-gradient(to right, ${minor} 0 1px, transparent 1px 8px)`,
        `repeating-linear-gradient(to right, ${major} 0 1px, transparent 1px 40px)`,
        ...Array(8).fill(`linear-gradient(${mark}, ${mark})`),
      ].join(","),
      backgroundSize: [`calc(100% - ${2 * x}px) 5px`, `calc(100% - ${2 * x}px) 9px`, `${m}px 1px`, `1px ${m}px`, `${m}px 1px`, `1px ${m}px`, `${m}px 1px`, `1px ${m}px`, `${m}px 1px`, `1px ${m}px`].join(","),
      backgroundPosition: [`${x}px 0`, `${x}px 0`, "0 0", "0 0", "100% 0", "100% 0", "0 100%", "0 100%", "100% 100%", "100% 100%"].join(","),
      backgroundRepeat: "no-repeat",
      ...style,
    }}>
      {label && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, fontFamily: mono, fontSize: 15, letterSpacing: "0.12em", textTransform: "uppercase", color: light ? C.inkMuted : C.muted, marginBottom: 14 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 8, height: 8, background: dot ?? C.acc }} />
            <b style={{ fontWeight: 500, color: light ? C.ink : C.text }}>{label}</b>
          </span>
          {meta && <span style={{ textTransform: "none", letterSpacing: "0.03em" }}>{meta}</span>}
        </div>
      )}
      {children}
    </div>
  );
};
