/**
 * Structured-output schema for the analyst model. Validated with zod on the way back in;
 * the API side is constrained with `output_config.format = zodOutputFormat(schema)`.
 *
 * Keep constraints loose here - guards.ts is the authority that clamps values. Numeric
 * min/max would only be validated client-side by the SDK and turn a clampable answer
 * into a parse failure.
 */
import { z } from "zod";

export const AnalystOutputSchema = z.object({
  recommendedLimits: z.object({
    maxPerTxUsdc: z.number(),
    maxPerDayUsdc: z.number(),
  }),
  /** plain-English, reviewer-facing, <= 120 words (enforced by guards) */
  rationale: z.string(),
  /** Enhanced Due Diligence questions; must be [] for LOW (enforced by guards) */
  eddRequested: z.array(z.string()),
  /** seconds until next re-screen; clamped into the tier window by guards */
  nextRescreenInSeconds: z.number(),
  /** 2 to ask the pipeline for a second funder hop before the final verdict; null otherwise */
  requestDepth: z.literal(2).nullable(),
  /** 0..1 self-assessed confidence in limits/cadence (not in the tier) */
  confidence: z.number(),
});
export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;

/** Output of the cheap hop-2 decision call. */
export const DepthOutputSchema = z.object({
  goDeeper: z.boolean(),
  reason: z.string(),
});
export type DepthOutput = z.infer<typeof DepthOutputSchema>;
