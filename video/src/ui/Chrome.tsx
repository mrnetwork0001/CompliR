import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { T } from "../timing";
import { mono, SCENE_TONE, TONE } from "../theme";
import { clamp } from "./motion";

/** Corner furniture: the event (bottom left) and the URL (bottom right). */
export const Chrome: React.FC<{ hideAfter?: number }> = ({ hideAfter }) => {
  const f = useCurrentFrame();
  const sc = T.scenes.find((s) => f >= s.from && f < s.from + s.durationInFrames) ?? T.scenes[T.scenes.length - 1];
  const tone = TONE[SCENE_TONE[sc.id] ?? "dark"];
  const op = hideAfter != null ? interpolate(f, [hideAfter, hideAfter + 12], [1, 0], clamp) : 1;
  const base: React.CSSProperties = { position: "absolute", fontFamily: mono, fontSize: 15, letterSpacing: "0.06em", color: tone.muted, opacity: op, textTransform: "uppercase" };
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ ...base, left: 48, bottom: 34, fontSize: 13 }}>tameion agents hackathon · arc mainnet 5042</div>
      <div style={{ ...base, right: 48, bottom: 34, fontSize: 13, textTransform: "none" }}>trycomplir.xyz</div>
    </AbsoluteFill>
  );
};
