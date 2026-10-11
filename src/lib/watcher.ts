/** Watcher core: re-screens due counterparties on the analyst's cadence and pushes webhooks on tier change. */
import { dueWatches, updateWatchAfterRescreen } from "./store";
import { appendDecision } from "./ledger";
import { screen } from "./pipeline";
import type { Tier, TierChangeEvent, Verdict, Watch } from "./types";
import { anchorIfDue } from "./chain/anchorWriter";

/**
 * Tier change for one watch: append TIER_CHANGE to the ledger, then POST the `tier.changed` webhook (8 s timeout).
 * Shared by the cadence watcher and the event reactor (src/lib/events). Returns whether the webhook was delivered.
 */
export async function pushTierChange(
  w: Pick<Watch, "id" | "address" | "webhookUrl" | "clientId">,
  v: Verdict,
  from: Tier | null,
  opts: { trigger?: string; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const { evidence: _evidence, ...rest } = v;
  const evt: TierChangeEvent = { type: "tier.changed", address: w.address, from, to: v.tier, verdict: rest, registryTx: v.attestation.registryTx };
  await appendDecision({ kind: "TIER_CHANGE", subject: w.address, clientId: w.clientId, payload: { from, to: v.tier, decisionId: v.decisionId, watchId: w.id, ...(opts.trigger ? { trigger: opts.trigger } : {}) } });
  const doFetch = opts.fetchImpl ?? fetch;
  return doFetch(w.webhookUrl, {
    method: "POST", headers: { "content-type": "application/json", "x-complir-event": "tier.changed" },
    body: JSON.stringify(evt), signal: AbortSignal.timeout(8000),
  }).then((r) => r.ok, (e) => { console.warn("[watcher] webhook failed", w.webhookUrl, (e as Error)?.message); return false; });
}

export async function runWatcherOnce(): Promise<{ checked: number; changed: number; failed: number; anchor: Awaited<ReturnType<typeof anchorIfDue>> }> {
  const due = await dueWatches();
  let changed = 0, failed = 0;
  for (const w of due) {
    try {
      const v = await screen({ address: w.address, clientId: w.clientId ?? undefined, payeeBook: w.payeeBook ?? undefined }, { kind: "RESCREEN" });
      const next = Math.floor(new Date(v.nextRescreenAt).getTime() / 1000);
      if (w.lastTier !== null && w.lastTier !== v.tier) {
        changed++;
        await pushTierChange(w, v, w.lastTier);
      }
      await updateWatchAfterRescreen(w.id, v.tier, next);
    } catch (e) {
      failed++;
      console.warn("[watcher] rescreen failed", w.address, (e as Error)?.message);
      await updateWatchAfterRescreen(w.id, w.lastTier ?? "LOW", Math.floor(Date.now() / 1000) + 600);
    }
  }
  const anchor = await anchorIfDue().catch((e) => ({ anchored: false as const, count: 0, reason: `anchor failed: ${(e as Error)?.message}` }));
  return { checked: due.length, changed, failed, anchor };
}
