/**
 * Shadow-mode logic: screen a client's payee book (bounded concurrency) and report what we would
 * have held/limited. Kept out of route.ts so it is unit-testable and the route only exports `POST`.
 */
import { z } from "zod";
import { AddressSchema, PayeeBookEntrySchema, type Address, type PayeeBookEntry, type Verdict } from "@/lib/types";
import type { ShadowEntry, ShadowPayment, ShadowResponse } from "./public-types";

export const SHADOW_MAX_ADDRESSES = 50;
export const SHADOW_CONCURRENCY = 4;

export const ShadowRequestSchema = z.object({
  payeeBook: z.array(PayeeBookEntrySchema).min(1).max(500),
  recentPayments: z
    .array(
      z.object({
        to: AddressSchema,
        amountUsdc: z.number().nonnegative(),
        txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "invalid tx hash").optional(),
      }),
    )
    .max(1000)
    .optional(),
});
export type ShadowRequest = z.infer<typeof ShadowRequestSchema>;

/** Payee-book addresses first (in order), then payment recipients not in the book. De-duplicated, capped. */
export function uniqueTargets(req: ShadowRequest, max = SHADOW_MAX_ADDRESSES): { label: string; address: Address }[] {
  const seen = new Set<Address>();
  const out: { label: string; address: Address }[] = [];
  for (const p of req.payeeBook) {
    if (seen.has(p.address)) continue;
    seen.add(p.address);
    out.push({ label: p.label, address: p.address });
    if (out.length >= max) return out;
  }
  for (const p of req.recentPayments ?? []) {
    if (seen.has(p.to)) continue;
    seen.add(p.to);
    out.push({ label: "(unlisted payment recipient)", address: p.to });
    if (out.length >= max) return out;
  }
  return out;
}

/** Run `fn` over `items` with at most `concurrency` in flight; preserves order. */
export async function mapLimit<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return results;
}

export type Screener = (req: { address: Address; payeeBook: PayeeBookEntry[]; depth: 1 }) => Promise<Verdict>;

export async function runShadow(req: ShadowRequest, screen: Screener): Promise<ShadowResponse> {
  const targets = uniqueTargets(req);
  const verdicts = await mapLimit(targets, SHADOW_CONCURRENCY, (t) =>
    screen({ address: t.address, payeeBook: req.payeeBook, depth: 1 }),
  );

  const entries: ShadowEntry[] = targets.map((t, i) => {
    const v = verdicts[i];
    return {
      label: t.label,
      address: t.address,
      score: v.score,
      tier: v.tier,
      reasonCodes: v.reasons.map((r) => r.code),
      wouldHold: v.tier === "HIGH",
      wouldLimit: v.tier === "MEDIUM",
    };
  });

  const tierOf = new Map<string, ShadowEntry["tier"]>(entries.map((e) => [e.address, e.tier]));
  const paymentsAtRisk: ShadowPayment[] = (req.recentPayments ?? [])
    .filter((p) => {
      const tier = tierOf.get(p.to);
      return tier !== undefined && tier !== "LOW";
    })
    .map((p) => ({ to: p.to, amountUsdc: p.amountUsdc, ...(p.txHash ? { txHash: p.txHash } : {}) }));

  return {
    entries,
    summary: {
      screened: entries.length,
      wouldHold: entries.filter((e) => e.wouldHold).length,
      wouldLimit: entries.filter((e) => e.wouldLimit).length,
      lookalikes: entries.filter((e) => e.reasonCodes.includes("LOOKALIKE_OF_KNOWN_PAYEE")).length,
    },
    paymentsAtRisk,
  };
}
