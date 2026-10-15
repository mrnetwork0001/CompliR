import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadMono } from "@remotion/google-fonts/GeistMono";
import { loadFont as loadSerif } from "@remotion/google-fonts/InstrumentSerif";

export const sans = loadGeist("normal", { weights: ["300", "400", "500", "600"], subsets: ["latin"] }).fontFamily;
export const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;
export const serif = loadSerif("italic", { weights: ["400"], subsets: ["latin"] }).fontFamily;

/** CompliR's own tokens (src/app/globals.css): near-black, one signal cyan, tier colours. */
export const C = {
  bg: "#0a0b0d",
  panel: "#121418",
  text: "#ecedee",
  muted: "#9ba1a9",
  faint: "#60656d",
  line: "rgba(236,237,238,0.08)",
  line2: "rgba(236,237,238,0.16)",
  acc: "#3fe0c8",
  accInk: "#06211d",
  paper: "#f5f4ef",
  ink: "#0d0f12",
  inkMuted: "#5b5f66",
  low: "#4ade80",
  medium: "#fbbf24",
  high: "#f87171",
  usdc: "#2775CA",
};

export type Tone = "dark" | "paper" | "cyan";
export const TONE: Record<Tone, { bg: string; ink: string; muted: string; line: string }> = {
  dark: { bg: C.bg, ink: C.text, muted: "rgba(236,237,238,0.5)", line: C.line2 },
  paper: { bg: C.paper, ink: C.ink, muted: "rgba(13,15,18,0.5)", line: "rgba(13,15,18,0.14)" },
  cyan: { bg: C.acc, ink: C.accInk, muted: "rgba(6,33,29,0.6)", line: "rgba(6,33,29,0.22)" },
};

export const SCENE_TONE: Record<string, Tone> = {
  open: "dark", problem: "paper", evidence: "cyan", gap: "paper", turn: "dark", check: "dark",
  verdict: "dark", signed: "dark", company: "dark", integrate: "dark", unique: "cyan", close: "dark",
};

export const SCENE_LABEL: Record<string, string> = {
  open: "01 · the wallet", problem: "02 · the problem", evidence: "03 · the evidence", gap: "04 · the gap",
  turn: "05 · complir", check: "06 · check", verdict: "07 · verdict", signed: "08 · signed",
  company: "09 · the company", integrate: "10 · integrate", unique: "11 · why it's different", close: "12 · screen before you pay",
};

export const TIER_COLOR = { LOW: C.low, MEDIUM: C.medium, HIGH: C.high } as const;
