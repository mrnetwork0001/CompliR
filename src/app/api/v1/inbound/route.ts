/**
 * GET /api/v1/inbound?limit=50 - the last inbound CCTP mints to Arc that CompliR screened (public, free).
 * The source-chain sender is masked (`0x1234…abcd`); the Arc recipient is public on-chain data and is what
 * /api/v1/inbound/{address} indexes by. See docs/CCTP.md.
 */
import { countInbound, recentInbound } from "@/lib/cctp/store";
import { getMeta } from "@/lib/cctp/store";
import { maskAddress } from "@/lib/store";
import { handle, ok } from "../../_lib/respond";
import { parseLimit } from "../../_lib/parse";
import { toPublicInbound, type InboundResponse } from "./public";

export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const limit = parseLimit(url, { def: 50, max: 100 });
  const [rows, counts, cursor, lastTick] = await Promise.all([recentInbound(limit), countInbound(), getMeta("cursor_block"), getMeta("last_tick")]);
  let tick: { at: number; head?: number; fromBlock?: number; toBlock?: number } | null = null;
  try { tick = lastTick ? JSON.parse(lastTick) : null; } catch { tick = null; }
  const body: InboundResponse = {
    items: rows.map((r) => toPublicInbound(r, maskAddress)),
    limit,
    total: counts.total,
    flagged: counts.flagged,
    cursorBlock: cursor == null ? null : Number(cursor),
    lastTickAt: tick?.at ? new Date(tick.at * 1000).toISOString() : null,
    source: "store",
  };
  return ok(body);
});
