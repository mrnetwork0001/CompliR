import React from "react";
import { AbsoluteFill, Audio, Freeze, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { T, scene, wordAt, lineStart } from "./timing";
import { C } from "./theme";
import { Chrome } from "./ui/Chrome";
import { Captions } from "./ui/Captions";
import { Grain } from "./ui/Grain";
import { clamp } from "./ui/motion";
import { Open } from "./scenes/Open";
import { Problem } from "./scenes/Problem";
import { Evidence } from "./scenes/Evidence";
import { Gap } from "./scenes/Gap";
import { Turn } from "./scenes/Turn";
import { Check } from "./scenes/Check";
import { Verdict } from "./scenes/Verdict";
import { Signed } from "./scenes/Signed";
import { Company } from "./scenes/Company";
import { Integrate } from "./scenes/Integrate";
import { Unique } from "./scenes/Unique";
import { Close } from "./scenes/Close";

const SCENES: Record<string, React.FC> = {
  open: Open, problem: Problem, evidence: Evidence, gap: Gap, turn: Turn, check: Check,
  verdict: Verdict, signed: Signed, company: Company, integrate: Integrate, unique: Unique, close: Close,
};
const OVERLAP = 10;

/** Each scene eases in over the tail of the previous one, holding its first frame while it dissolves. */
const SceneIn: React.FC<{ S: React.FC; first: boolean }> = ({ S, first }) => {
  const f = useCurrentFrame();
  if (first) return <S />;
  const p = interpolate(f, [0, OVERLAP], [0, 1], { ...clamp, easing: (t) => 1 - Math.pow(1 - t, 3) });
  const body = f < OVERLAP ? <Freeze frame={0}><S /></Freeze> : <Sequence from={OVERLAP} layout="none"><S /></Sequence>;
  return <AbsoluteFill style={{ opacity: p, transform: `scale(${1.03 - 0.03 * p})`, filter: p < 1 ? `blur(${(1 - p) * 10}px)` : undefined }}>{body}</AbsoluteFill>;
};

// Music, ducked under every spoken line.
const LINES = T.scenes.flatMap((s) => s.lines.map((l) => [l.startFrame, l.words[l.words.length - 1].end] as const));
const DUCK: number[] = (() => {
  const v = new Array<number>(T.totalFrames + 1).fill(0);
  for (let f = 0; f <= T.totalFrames; f++) {
    let d = 0;
    for (const [a, b] of LINES) d = Math.max(d, interpolate(f, [a - 10, a, b, b + 14], [0, 1, 1, 0], clamp));
    v[f] = d;
  }
  return v;
})();
const musicVolume = (f: number) => {
  const end = T.totalFrames;
  const fadeIn = interpolate(f, [0, 24], [0, 1], clamp);
  const fadeOut = interpolate(f, [end - 60, end], [1, 0], clamp);
  return (0.55 - 0.36 * DUCK[Math.min(end, Math.max(0, f))]) * fadeIn * fadeOut;
};

interface Fx { file: string; at: number; vol: number; dur?: number }
function effects(): Fx[] {
  const sc = (id: string) => scene(id).from;
  const w = (id: string, word: string, n = 0) => wordAt(id, word, n);
  const fx: Fx[] = [
    { file: "drone", at: 0, vol: 0.45, dur: 120 },
    { file: "tick", at: w("open", "six") - 2, vol: 0.4 },
    { file: "whoosh", at: w("open", "wallet") - 8, vol: 0.25 },
    { file: "typing", at: w("open", "wallet"), vol: 0.2, dur: 40 },
    { file: "deny", at: w("open", "sanctions") - 1, vol: 0.45 },
    { file: "swoosh_up", at: w("open", "Anyone") - 2, vol: 0.3 },
    { file: "whoosh", at: sc("problem") - 6, vol: 0.3 },
    { file: "pop", at: w("problem", "vendor") - 2, vol: 0.4 },
    { file: "blip", at: w("problem", "launderer.") - 1, vol: 0.4 },
    ...["one", "once,", "yes"].map((x) => ({ file: "click", at: w("problem", x) - 1, vol: 0.4 })),
    { file: "swoosh_up", at: sc("evidence") - 6, vol: 0.35 },
    { file: "blip", at: w("evidence", "hundred") + 2, vol: 0.4 },
    { file: "blip", at: w("evidence", "nearly") + 2, vol: 0.35 },
    { file: "pop", at: w("evidence", "half") - 2, vol: 0.4 },
    { file: "whoosh", at: sc("gap") - 6, vol: 0.3 },
    ...["grades", "watching", "contract"].map((x) => ({ file: "tick", at: w("gap", x) - 2, vol: 0.45 })),
    { file: "riser", at: sc("turn") - 100, vol: 0.4 },
    { file: "impact", at: w("turn", "CompliR.") - 4, vol: 0.55 },
    { file: "whoosh", at: sc("check") - 6, vol: 0.3 },
    { file: "typing", at: sc("check") + 34, vol: 0.18, dur: 90 },
    { file: "click", at: sc("check") + 132, vol: 0.4 },
    { file: "scan", at: w("check", "sanctions") - 2, vol: 0.3 },
    ...["Circle's", "two"].map((x) => ({ file: "pop", at: w("check", x) - 1, vol: 0.35 })),
    { file: "deny", at: lineStart("verdict", 0) - 4, vol: 0.4 },
    { file: "lock", at: w("verdict", "never") - 2, vol: 0.45 },
    { file: "blip", at: w("verdict", "score.") + 6, vol: 0.35 },
    { file: "seal", at: w("signed", "signed,") - 2, vol: 0.4 },
    { file: "pop", at: w("signed", "registry") - 2, vol: 0.35 },
    { file: "click", at: w("signed", "contract") - 2, vol: 0.4 },
    { file: "blip", at: w("signed", "minute.") - 2, vol: 0.4 },
    { file: "whoosh", at: sc("company") - 6, vol: 0.3 },
    ...["cent", "x402.", "Circle"].map((x) => ({ file: "pop", at: w("company", x) - 1, vol: 0.35 })),
    { file: "whoosh", at: lineStart("company", 1) - 8, vol: 0.25 },
    { file: "deny", at: w("company", "refused.") - 2, vol: 0.45 },
    { file: "tick", at: w("company", "cut") + 8, vol: 0.4 }, { file: "tick", at: w("company", "cut") + 18, vol: 0.4 },
    { file: "whoosh", at: sc("integrate") - 6, vol: 0.3 },
    { file: "chime", at: w("integrate", "Inktoll,") - 2, vol: 0.35 },
    { file: "swoosh_up", at: sc("unique") - 6, vol: 0.35 },
    ...["Graded,", "Signed,", "run"].map((x) => ({ file: "impact", at: w("unique", x) - 4, vol: 0.22 })),
    { file: "whoosh", at: sc("close") - 6, vol: 0.3 },
    ...["Arc,", "USDC", "Circle."].map((x) => ({ file: "pop", at: w("close", x) - 1, vol: 0.35 })),
    { file: "chime", at: w("close", "pay.") - 2, vol: 0.45 },
  ];
  return fx.filter((x) => x.at >= 0 && x.at < T.totalFrames);
}

export const Film: React.FC = () => {
  // Captions sit out where the picture already carries the words.
  const hideCaptions = (f: number) => {
    const s = T.scenes.find((x) => f >= x.from && f < x.from + x.durationInFrames);
    return !s || ["turn", "gap", "unique", "close"].includes(s.id);
  };
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {T.scenes.map((s, i) => {
        const S = SCENES[s.id];
        const from = i === 0 ? s.from : s.from - OVERLAP;
        const dur = s.durationInFrames + (i === 0 ? 0 : OVERLAP);
        return S ? (
          <Sequence key={s.id} from={from} durationInFrames={dur} name={s.id}>
            <SceneIn S={S} first={i === 0} />
          </Sequence>
        ) : null;
      })}
      <Grain opacity={0.05} />
      <Chrome hideAfter={scene("close").from + 30} />
      <Captions hidden={hideCaptions} />
      <Audio src={staticFile("audio/music.mp3")} volume={musicVolume} />
      {T.scenes.flatMap((s) => s.lines).map((l, i) => (
        <Sequence key={`vo${i}`} from={l.startFrame} durationInFrames={l.durationFrames} name={`vo ${l.text.slice(0, 18)}`}>
          <Audio src={staticFile(l.file)} volume={1} />
        </Sequence>
      ))}
      {effects().map((x, i) => (
        <Sequence key={`fx${i}`} from={x.at} durationInFrames={x.dur ?? 150} name={`fx ${x.file}`}>
          <Audio src={staticFile(`audio/sfx/${x.file}.mp3`)} volume={(f) => x.vol * (x.dur ? interpolate(f, [0, 8, x.dur - 20, x.dur], [0, 1, 1, 0], clamp) : 1)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
