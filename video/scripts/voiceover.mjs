// Voice-over for every line in script.json, via ElevenLabs /with-timestamps.
//   node scripts/voiceover.mjs              generate changed/missing lines (hash cache)
//   ONLY=problem_2 node scripts/voiceover.mjs   force one or more ids (comma list)
// Outputs:
//   public/audio/vo/<sceneId>_<i>.mp3        (what the film plays; loudness-normalised to -16 LUFS)
//   .cache/raw/<sceneId>_<i>.mp3             (untouched take; timing.mjs may atempo from it)
//   .cache/words/<sceneId>_<i>.json          (word timings in seconds, from char alignment)
//   .cache/vo.json                           (hash per line + chars consumed log)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOT, post, retry } from "./env.mjs";
import { renderVo } from "./vofx.mjs";

const script = JSON.parse(readFileSync(join(ROOT, "script.json"), "utf8"));
const OUT = join(ROOT, "public/audio/vo");
const RAW = join(ROOT, ".cache/raw");
const WORDS = join(ROOT, ".cache/words");
const CACHE = join(ROOT, ".cache/vo.json");
for (const d of [OUT, RAW, WORDS]) mkdirSync(d, { recursive: true });
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : { lines: {}, charsUsed: 0 };

// Per-line performance direction (overrides merged over the voice settings).
const OVERRIDES = {
  // The cold open: unhurried, a little weight on the date.
  open_0: { stability: 0.48, style: 0.3, speed: 0.93 },
  open_1: { stability: 0.5, style: 0.28, speed: 0.95 },
  // The oracle reads the app's own verdict: flat, exact, machine-calm.
  verdict_0: { stability: 0.85, style: 0.0, speed: 0.95 },
  turn_0: { stability: 0.55, style: 0.32, speed: 0.9 },
  unique_0: { speed: 0.95 },
  // The close: slow and settled.
  close_0: { stability: 0.6, style: 0.3, speed: 0.88 },
};

// Written form (captions, word sync) -> spoken form (what the voice reads).
// After synthesis the spoken words are folded back to the written ones, keeping their timings.
const SAY = [
  ["CompliR", "Complier"],
  ["x402", "x four oh two"],
];
const toSpoken = (text) => SAY.reduce((t, [w, s]) => t.replaceAll(w, s), text);
function foldWords(words, text) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    let hit = null;
    for (const [w, s] of SAY) {
      const parts = s.split(" ");
      const seq = words.slice(i, i + parts.length).map((x) => x.word.replace(/[^A-Za-z0-9']/g, "").toLowerCase());
      if (seq.join(" ") === parts.map((p) => p.toLowerCase()).join(" ")) { hit = { w, n: parts.length }; break; }
    }
    if (!hit) { out.push(words[i]); continue; }
    const last = words[i + hit.n - 1];
    const trail = last.word.match(/[^A-Za-z0-9']+$/)?.[0] ?? "";
    const lead = words[i].word.match(/^[^A-Za-z0-9']+/)?.[0] ?? "";
    out.push({ word: lead + hit.w + trail, start: words[i].start, end: last.end });
    i += hit.n - 1;
  }
  const want = text.split(/\s+/).length;
  if (out.length !== want) console.warn(`  word count ${out.length} != written ${want}`);
  return out;
}

const only = process.env.ONLY ? process.env.ONLY.split(",") : null;

export const durationOf = (f) =>
  parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f]).toString());

function toWords(a) {
  const words = [];
  let cur = null;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) { if (cur) { words.push(cur); cur = null; } return; }
    if (!cur) cur = { word: "", start: a.character_start_times_seconds[i], end: 0 };
    cur.word += ch;
    cur.end = a.character_end_times_seconds[i];
  });
  if (cur) words.push(cur);
  return words;
}

async function synth(text, voiceId, settings) {
  return retry(async () => {
    const res = await post(`/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
      text, model_id: script.model, voice_settings: settings,
    });
    const body = await res.json();
    return { audio: Buffer.from(body.audio_base64, "base64"), words: toWords(body.alignment) };
  });
}

// Speech rate sanity: normal read is ~11-18 chars/sec of speech.
const sane = (text, words) => {
  const speech = words.at(-1).end - words[0].start;
  const cps = text.length / speech;
  return { ok: cps >= 8 && cps <= 21, cps };
};

let used = 0;
for (const scene of script.scenes) {
  for (const [i, line] of scene.lines.entries()) {
    const id = `${scene.id}_${i}`;
    const voice = script.voices[line.voice];
    const settings = { ...voice.settings, ...(OVERRIDES[id] || {}) };
    const hash = createHash("sha1").update(JSON.stringify([line.text, voice.id, settings, script.model])).digest("hex");
    const have = existsSync(join(OUT, `${id}.mp3`)) && existsSync(join(WORDS, `${id}.json`));
    if (have && cache.lines[id]?.hash === hash && !(only && only.includes(id))) { console.log(`${id}: cached`); continue; }
    if (only && !only.includes(id) && have) continue;

    let take = await synth(toSpoken(line.text), voice.id, settings);
    used += line.text.length;
    let chk = sane(line.text, take.words);
    if (!chk.ok) {
      console.log(`${id}: ${chk.cps.toFixed(1)} cps looks off, retaking once`);
      const again = await synth(toSpoken(line.text), voice.id, settings);
      used += line.text.length;
      const chk2 = sane(line.text, again.words);
      if (Math.abs(chk2.cps - 14) < Math.abs(chk.cps - 14)) { take = again; chk = chk2; }
    }
    writeFileSync(join(RAW, `${id}.mp3`), take.audio);
    renderVo(id, 1);
    writeFileSync(join(WORDS, `${id}.json`), JSON.stringify({ tempo: 1, words: foldWords(take.words, line.text) }, null, 1));
    const dur = durationOf(join(OUT, `${id}.mp3`));
    cache.lines[id] = { hash, voice: voice.id, chars: line.text.length, dur };
    console.log(`${id}: ${dur.toFixed(2)}s  ${chk.cps.toFixed(1)} cps  [${line.voice}/${voice.id}]`);
  }
}
cache.charsUsed = (cache.charsUsed || 0) + used;
writeFileSync(CACHE, JSON.stringify(cache, null, 1));
console.log(`chars this run: ${used}, total logged: ${cache.charsUsed}`);
