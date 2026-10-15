import React from "react";
import { AbsoluteFill, Freeze, Img, OffthreadVideo, interpolate, staticFile, useCurrentFrame } from "remotion";
import footage from "../footage.json";
import { C, mono, sans } from "../theme";
import { clamp, soft } from "./motion";

export interface Rect { x: number; y: number; w: number; h: number }
export interface Clip { file: string; width: number; height: number; durationFrames: number; marks?: Record<string, number>; rects?: Record<string, Rect | null> }
const LIB = footage as unknown as Record<string, Clip>;
export const clip = (name: string): Clip | undefined => LIB[name];
export const markOf = (name: string, m: string): number => clip(name)?.marks?.[m] ?? 0;

/** The page the footage was recorded at, in CSS pixels. */
export const PAGE = { w: 1600, h: 900 };

/**
 * A dark browser window playing a recorded clip of the live site. The camera moves from the
 * whole page to `focus` (a rect in page CSS px, or a rect name from the clip) between frames
 * `focusAt[0]` and `focusAt[1]`, at `zoom` times the window's fit.
 */
export const Browser: React.FC<{
  name: string; url: string; width: number; left: number; top: number;
  startFrom?: number; focus?: Rect | string; zoom?: number; focusAt?: [number, number]; unfocusAt?: [number, number];
  still?: string; enter?: number; tilt?: number; opacity?: number; freezeAt?: number;
}> = ({ name, url, width, left, top, startFrom = 0, focus, zoom = 1.8, focusAt = [0, 1], unfocusAt, still, enter = 0, tilt = 0, opacity = 1, freezeAt }) => {
  const f = useCurrentFrame();
  const c = clip(name);
  const bar = 44;
  const vh = (width * PAGE.h) / PAGE.w;
  const k = width / PAGE.w;
  const rect: Rect | undefined = (typeof focus === "string" ? c?.rects?.[focus] : focus) ?? undefined;
  let p = rect ? interpolate(f, focusAt, [0, 1], { ...clamp, easing: soft }) : 0;
  if (rect && unfocusAt) p *= interpolate(f, unfocusAt, [1, 0], { ...clamp, easing: soft });
  const s = 1 + (zoom - 1) * p;
  const cx = rect ? rect.x + rect.w / 2 : PAGE.w / 2;
  const cy = rect ? rect.y + rect.h / 2 : PAGE.h / 2;
  const txFull = width / 2 - cx * k * s;
  const tyFull = vh / 2 - cy * k * s;
  const tx = Math.min(0, Math.max(width - PAGE.w * k * s, txFull)) * (p > 0 ? 1 : 0);
  const ty = Math.min(0, Math.max(vh - PAGE.h * k * s, tyFull)) * (p > 0 ? 1 : 0);
  const inP = interpolate(f, [enter, enter + 18], [0, 1], { ...clamp, easing: soft });
  return (
    <div style={{
      position: "absolute", left, top, width, height: vh + bar, borderRadius: 10, overflow: "hidden",
      background: C.bg, boxShadow: `0 0 0 1px ${C.line2}, 0 40px 100px rgba(0,0,0,0.55), 0 0 80px rgba(63,224,200,0.06)`,
      opacity: inP * opacity, transform: `translateY(${(1 - inP) * 40}px) perspective(2400px) rotateX(${tilt * (1 - inP)}deg)`,
    }}>
      <div style={{ height: bar, display: "flex", alignItems: "center", gap: 9, padding: "0 18px", background: "#15171b", borderBottom: `1px solid ${C.line2}` }}>
        {["#3a3d42", "#3a3d42", "#3a3d42"].map((col, i) => <span key={i} style={{ width: 11, height: 11, borderRadius: 6, background: col }} />)}
        <div style={{ marginLeft: 18, flex: 1, height: 26, borderRadius: 4, background: "#0e1013", border: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 10, padding: "0 14px", fontFamily: mono, fontSize: 14, color: C.muted }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: C.acc }} />{url}
        </div>
      </div>
      <div style={{ position: "relative", width, height: vh, overflow: "hidden", background: C.bg }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: PAGE.w, height: PAGE.h, transformOrigin: "0 0", transform: `translate(${tx}px, ${ty}px) scale(${k * s})` }}>
          {c ? (
            freezeAt != null && f >= freezeAt - startFrom ? (
              <Freeze frame={freezeAt - startFrom}><OffthreadVideo src={staticFile(c.file)} startFrom={startFrom} muted style={{ width: PAGE.w, height: PAGE.h }} /></Freeze>
            ) : (
              <OffthreadVideo src={staticFile(c.file)} startFrom={startFrom} muted style={{ width: PAGE.w, height: PAGE.h }} />
            )
          ) : still ? (
            <Img src={staticFile(still)} style={{ width: PAGE.w, height: PAGE.h }} />
          ) : (
            <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", fontFamily: sans, color: C.muted, fontSize: 28 }}>footage “{name}” pending</AbsoluteFill>
          )}
        </div>
      </div>
    </div>
  );
};
