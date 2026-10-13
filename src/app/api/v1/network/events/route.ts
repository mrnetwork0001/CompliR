/**
 * GET /api/v1/network/events?limit=50 — the last blocklist events the reactor saw (on-chain Blacklisted /
 * UnBlacklisted on USDC, plus drills marked `simulated: true`) and what happened: whether we re-screened,
 * tierFrom → tierTo, webhooks delivered / watches on the address, latency. Free; the on-chain facts are public anyway.
 */
import { getEventsMeta, listEventLogs } from "@/lib/events";
import { handle, ok } from "../../../_lib/respond";
import { parseLimit } from "../../../_lib/parse";

export const GET = handle(async (req: Request) => {
  const limit = parseLimit(new URL(req.url), { def: 50, max: 200 });
  const [items, lastTick] = await Promise.all([listEventLogs(limit), getEventsMeta("last_tick")]);
  let tick: unknown = null;
  try { tick = lastTick ? JSON.parse(lastTick) : null; } catch { tick = null; }
  return ok({
    items: items.map((e) => ({ ...e, handledAt: new Date(e.handledAt * 1000).toISOString() })),
    limit,
    lastTick: tick,
    generatedAt: new Date().toISOString(),
  });
});
