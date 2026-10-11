/**
 * Post-validation of the analyst's structured output. Code, not the model, has the last word.
 *
 * DUPLICATION NOTE: TIER_LIMIT_BANDS / clampLimits mirror src/lib/scoring/limits.ts
 * (`limitsForTier`, `clampLimits`) which is owned by another agent. Dedupe once both land.
 */
import type { AnalystDecision, EvidenceBundle, Reason, ScreenRequest, Tier } from "../types";
import type { AnalystOutput } from "./schema";

export interface Limits {
  maxPerTxUsdc: number;
  maxPerDayUsdc: number;
}

/** Hard ceilings per tier. Must equal scoring/limits.ts bands. */
export const TIER_LIMIT_BANDS: Record<Tier, Limits> = {
  LOW: { maxPerTxUsdc: 10_000, maxPerDayUsdc: 50_000 },
  MEDIUM: { maxPerTxUsdc: 250, maxPerDayUsdc: 1_000 },
  HIGH: { maxPerTxUsdc: 0, maxPerDayUsdc: 0 },
};

/** Re-screen cadence window per tier (seconds). Strategy §4 item 6: HIGH hourly -> LOW weekly. */
export const RESCREEN_WINDOW_SECONDS: Record<Tier, { min: number; max: number }> = {
  HIGH: { min: 300, max: 3_600 },
  MEDIUM: { min: 900, max: 86_400 },
  LOW: { min: 3_600, max: 604_800 },
};

export const MAX_RATIONALE_WORDS = 120;
export const MAX_EDD_QUESTIONS = 3;

// ─── Individual guards ───────────────────────────────────────────────────────

function finiteOr(n: unknown, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/** Clamp proposed limits into the tier band. HIGH is always 0/0. Day >= tx. */
export function clampLimits(tier: Tier, proposed: Partial<Limits> | null | undefined): { limits: Limits; changed: boolean } {
  const band = TIER_LIMIT_BANDS[tier];
  const tx = Math.max(0, Math.min(band.maxPerTxUsdc, Math.floor(finiteOr(proposed?.maxPerTxUsdc, band.maxPerTxUsdc))));
  let day = Math.max(0, Math.min(band.maxPerDayUsdc, Math.floor(finiteOr(proposed?.maxPerDayUsdc, band.maxPerDayUsdc))));
  if (day < tx) day = tx;
  const changed = tx !== proposed?.maxPerTxUsdc || day !== proposed?.maxPerDayUsdc;
  return { limits: { maxPerTxUsdc: tx, maxPerDayUsdc: day }, changed };
}

/** Effective window for a tier, tightened (halved max) after a tier change. */
export function rescreenWindow(tier: Tier, tierChanged: boolean): { min: number; max: number } {
  const w = RESCREEN_WINDOW_SECONDS[tier];
  const max = tierChanged ? Math.floor(w.max / 2) : w.max;
  return { min: Math.min(w.min, max), max };
}

/** Clamp a proposed cadence (seconds from now) into the tier window. */
export function clampRescreenSeconds(
  tier: Tier,
  proposedSeconds: unknown,
  tierChanged: boolean,
): { seconds: number; changed: boolean } {
  const w = rescreenWindow(tier, tierChanged);
  const raw = finiteOr(proposedSeconds, w.max);
  const seconds = Math.max(w.min, Math.min(w.max, Math.floor(raw)));
  return { seconds, changed: seconds !== proposedSeconds };
}

/** Default cadence when the model is unavailable: the top of the (possibly tightened) window. */
export function defaultRescreenSeconds(tier: Tier, tierChanged: boolean): number {
  return rescreenWindow(tier, tierChanged).max;
}

/** EDD only for MEDIUM/HIGH; trim, dedupe, cap. */
export function filterEdd(tier: Tier, proposed: unknown): { edd: string[]; changed: boolean } {
  const input = Array.isArray(proposed) ? proposed : [];
  if (tier === "LOW") return { edd: [], changed: input.length > 0 };
  const seen = new Set<string>();
  const edd: string[] = [];
  for (const q of input) {
    if (typeof q !== "string") continue;
    const t = q.trim();
    if (t.length < 8 || seen.has(t)) continue;
    seen.add(t);
    edd.push(t);
    if (edd.length >= MAX_EDD_QUESTIONS) break;
  }
  return { edd, changed: edd.length !== input.length };
}

const HEX_REF = /0x[0-9a-fA-F]{6,64}/g;
/** OpenSanctions canonical ids (NK-...) and Wikidata ids (Q123...) */
const ENTITY_REF = /\b(?:NK-[A-Za-z0-9]{4,}|Q\d{3,})\b/g;

/**
 * Every identifier a rationale is allowed to cite: all 0x hex strings and sanctions entity ids that
 * appear anywhere in the evidence bundle, the reasons' evidence, or the request. Lower-cased.
 */
export function collectKnownReferences(bundle: EvidenceBundle, reasons: Reason[], req?: ScreenRequest): Set<string> {
  const refs = new Set<string>();
  const blob = JSON.stringify({ bundle, reasons, req: req ?? null });
  for (const m of blob.match(HEX_REF) ?? []) refs.add(m.toLowerCase());
  for (const m of blob.match(ENTITY_REF) ?? []) refs.add(m.toLowerCase());
  return refs;
}

function isKnownRef(token: string, known: Set<string>): boolean {
  const t = token.toLowerCase();
  if (known.has(t)) return true;
  // allow an unambiguous prefix of a known identifier (>= 10 chars), e.g. "0x1234abcd56"
  if (t.length >= 10) for (const k of known) if (k.startsWith(t)) return true;
  return false;
}

/**
 * Anti-hallucination: remove any tx hash / address / entity id in the rationale that is not in the evidence,
 * then enforce the word limit.
 */
export function sanitizeRationale(
  rationale: unknown,
  known: Set<string>,
): { rationale: string; changed: boolean; stripped: string[] } {
  const stripped: string[] = [];
  let text = typeof rationale === "string" ? rationale : "";
  text = text.replace(HEX_REF, (m) => {
    if (isKnownRef(m, known)) return m;
    stripped.push(m);
    return "[unverified identifier removed]";
  });
  text = text.replace(ENTITY_REF, (m) => {
    if (isKnownRef(m, known)) return m;
    stripped.push(m);
    return "[unverified identifier removed]";
  });
  text = text.replace(/\s+/g, " ").trim();
  let truncated = false;
  const words = text.split(" ");
  if (words.length > MAX_RATIONALE_WORDS) {
    text = words.slice(0, MAX_RATIONALE_WORDS).join(" ") + " [...]";
    truncated = true;
  }
  return { rationale: text, changed: stripped.length > 0 || truncated, stripped };
}

export function clampConfidence(c: unknown): number {
  return Math.max(0, Math.min(1, finiteOr(c, 0.5)));
}

// ─── Composite ───────────────────────────────────────────────────────────────

export interface GuardContext {
  req: ScreenRequest;
  bundle: EvidenceBundle;
  tier: Tier;
  reasons: Reason[];
  priorTier?: Tier | null;
  /** unix seconds */
  now: number;
}

export interface GuardedDecision {
  decision: AnalystDecision;
  confidence: number;
  guardTriggered: boolean;
  /** human-readable list of what was clamped/stripped, for the decision log */
  guardNotes: string[];
}

export function tierChanged(ctx: Pick<GuardContext, "tier" | "priorTier" | "bundle">): boolean {
  const prior = ctx.priorTier ?? ctx.bundle.priorTier?.tier ?? null;
  return prior !== null && prior !== ctx.tier;
}

/** Apply every guard to a (model- or fallback-produced) output. Never throws. */
export function applyGuards(ctx: GuardContext, proposed: AnalystOutput): GuardedDecision {
  const notes: string[] = [];
  const changed = tierChanged(ctx);

  const lim = clampLimits(ctx.tier, proposed.recommendedLimits);
  if (lim.changed) notes.push(`limits clamped to ${ctx.tier} band: ${JSON.stringify(proposed.recommendedLimits)} -> ${JSON.stringify(lim.limits)}`);

  const cad = clampRescreenSeconds(ctx.tier, proposed.nextRescreenInSeconds, changed);
  if (cad.changed) notes.push(`rescreen clamped into ${ctx.tier} window${changed ? " (tightened: tier changed)" : ""}: ${proposed.nextRescreenInSeconds} -> ${cad.seconds}s`);

  const edd = filterEdd(ctx.tier, proposed.eddRequested);
  if (edd.changed) notes.push(ctx.tier === "LOW" ? "EDD dropped: LOW tier" : `EDD filtered: ${proposed.eddRequested.length} -> ${edd.edd.length}`);

  const known = collectKnownReferences(ctx.bundle, ctx.reasons, ctx.req);
  const rat = sanitizeRationale(proposed.rationale, known);
  if (rat.stripped.length) notes.push(`stripped unverified identifiers: ${rat.stripped.join(", ")}`);
  if (rat.changed && !rat.stripped.length) notes.push(`rationale truncated to ${MAX_RATIONALE_WORDS} words`);

  let requestDepth: 2 | undefined;
  if (proposed.requestDepth === 2) {
    if (ctx.bundle.depth >= 2) notes.push("requestDepth ignored: evidence already at depth 2");
    else if (ctx.req.depth === 1) notes.push("requestDepth ignored: client pinned depth 1");
    else requestDepth = 2;
  }

  const decision: AnalystDecision = {
    recommendedLimits: lim.limits,
    rationale: rat.rationale || `${ctx.tier} tier set by deterministic rules; no rationale produced.`,
    eddRequested: edd.edd,
    nextRescreenAt: ctx.now + cad.seconds,
    ...(requestDepth ? { requestDepth } : {}),
  };

  return { decision, confidence: clampConfidence(proposed.confidence), guardTriggered: notes.length > 0, guardNotes: notes };
}
