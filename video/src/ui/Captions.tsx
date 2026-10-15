import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C, mono, sans, SCENE_TONE } from "../theme";
import { T } from "../timing";
import { clamp } from "./motion";

/** Narration captions on a frosted pill: the current phrase, each word lighting as it is spoken. */
export const Captions: React.FC<{ hidden?: (frame: number) => boolean; bottom?: number }> = ({ hidden, bottom = 92 }) => {
  const frame = useCurrentFrame();
  if (hidden?.(frame)) return null;
  const sc = T.scenes.find((s) => frame >= s.from && frame < s.from + s.durationInFrames);
  const line = T.scenes.flatMap((s) => s.lines).find((l) => frame >= l.startFrame - 4 && frame <= l.words[l.words.length - 1].end + 14);
  if (!line || !sc) return null;
  const light = SCENE_TONE[sc.id] === "paper";
  const chunks: (typeof line.words)[] = [];
  let cur: typeof line.words = [];
  for (const w of line.words) {
    cur.push(w);
    if ((/[.,:;?]$/.test(w.word) && cur.length >= 4) || cur.length >= 10) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);
  let shown = chunks[0];
  for (const c of chunks) if (frame >= c[0].start - 3) shown = c;
  const lastEnd = line.words[line.words.length - 1].end;
  const op = interpolate(frame, [line.startFrame - 4, line.startFrame + 4, lastEnd + 6, lastEnd + 14], [0, 1, 1, 0], clamp);
  const oracle = line.voice === "oracle";
  const ink = light ? C.ink : C.text;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom, display: "flex", justifyContent: "center", opacity: op, pointerEvents: "none" }}>
      <div style={{
        maxWidth: 1320, textAlign: "center", fontFamily: sans, fontSize: 30, fontWeight: 450, lineHeight: 1.35, letterSpacing: "-0.01em",
        padding: "10px 26px", borderRadius: 4,
        background: light ? "rgba(255,255,255,0.82)" : "rgba(10,11,13,0.72)",
        boxShadow: light ? "0 0 0 1px rgba(13,15,18,0.10)" : `0 0 0 1px ${oracle ? "rgba(248,113,113,0.45)" : C.line2}`,
        backdropFilter: "blur(18px)",
      }}>
        {oracle ? <span style={{ fontFamily: mono, fontSize: 16, letterSpacing: "0.14em", color: C.high, marginRight: 14, verticalAlign: "middle" }}>COMPLIR · VERDICT</span> : null}
        {shown.map((w, i) => (
          <span key={i} style={{ color: ink, opacity: frame >= w.start - 2 ? 1 : 0.4 }}>{w.word} </span>
        ))}
      </div>
    </div>
  );
};
