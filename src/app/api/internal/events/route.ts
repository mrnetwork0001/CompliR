/**
 * POST|GET /api/internal/events - one USDC-blocklist reactor tick (Vercel Cron / external scheduler), or a drill.
 * Protected by `Authorization: Bearer $CRON_SECRET`, same pattern as /api/internal/watcher.
 *
 *   POST (empty body) / GET              → pollBlocklistEvents(): PollResult (blocks scanned, events, handled, webhooks)
 *   POST { "simulate": "0x…", "kind"? }  → the "blacklist drill": runs the SAME handler as if a Blacklisted
 *                                          (or, kind: "UNBLOCKLISTED", UnBlacklisted) event had just arrived for
 *                                          that address: relevance check → re-screen → webhooks → events_log.
 *
 * Drill recipe (video): 1) POST /api/v1/watch {address, webhookUrl}  2) add {"<address>": {"usdcBlacklisted": true}}
 * to .data/overrides.json (overrides merge over live chain facts)  3) POST here {simulate: "<address>"} - the
 * response shows tierFrom→tierTo and webhooks delivered; the webhook receives `tier.changed` within seconds.
 */
import { z } from "zod";
import { config } from "@/lib/config";
import { pollBlocklistEvents, simulateBlocklistEvent } from "@/lib/events";
import { AddressSchema } from "@/lib/types";

export const maxDuration = 120;

const Body = z.object({
  simulate: AddressSchema.optional(),
  kind: z.enum(["BLOCKLISTED", "UNBLOCKLISTED"]).default("BLOCKLISTED"),
});

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid CRON_SECRET" } }, { status: 401 });
  }
  if (config().COMPLIR_PAUSED) return Response.json({ error: { code: "SERVICE_PAUSED", message: "paused" } }, { status: 503 });
  try {
    let raw: unknown = {};
    if (req.method === "POST") {
      const text = await req.text().catch(() => "");
      if (text.trim()) {
        try { raw = JSON.parse(text); } catch { return Response.json({ error: { code: "INVALID_JSON", message: "body must be JSON" } }, { status: 400 }); }
      }
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: { code: "VALIDATION_ERROR", message: "invalid body", details: parsed.error.issues } }, { status: 400 });
    }
    if (parsed.data.simulate) {
      const entry = await simulateBlocklistEvent(parsed.data.simulate, parsed.data.kind);
      return Response.json({ simulated: true, event: entry });
    }
    return Response.json(await pollBlocklistEvents());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[events] tick failed:", e);
    return Response.json({ error: { code: "INTERNAL_ERROR", message } }, { status: 500 });
  }
}
export const GET = POST; // Vercel Cron uses GET
