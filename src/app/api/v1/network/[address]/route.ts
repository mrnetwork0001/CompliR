/**
 * GET /api/v1/network/:address — the cross-client network signal for one address. Free, anonymised.
 *
 * What only a shared oracle can answer:
 *   heldElsewhere      { clients, lastAt }        how many distinct integrators rated it HIGH in the window (count only)
 *   concentrationHint  { funder, otherPayees }    a hop-1 funder of the address also funded N other payees / graded nodes
 *   events             last blocklist events (on-chain or drills) that touched the address
 * `sharedFunder` ("shares a funder with N of YOUR payees") is client-scoped, so it is only returned inside a paid
 * screen (verdict.evidence.network) — never here. No client id, payee book or other address ever leaves the store.
 */
import { eventLogsOf } from "@/lib/events";
import { networkSignals } from "@/lib/network";
import { handle, ok } from "../../../_lib/respond";
import { parseAddress } from "../../../_lib/parse";

type Ctx = { params: Promise<{ address: string }> };

export const GET = handle<Ctx>(async (_req, { params }) => {
  const { address: raw } = await params;
  const address = parseAddress(raw, "path.address");
  const [signal, events] = await Promise.all([networkSignals(address, null), eventLogsOf(address, 10)]);
  return ok({
    address,
    heldElsewhere: signal.heldElsewhere,
    concentrationHint: signal.concentrationHint,
    windowDays: signal.windowDays,
    events: events.map((e) => ({
      kind: e.kind, eventName: e.eventName, simulated: e.simulated, block: e.block, txHash: e.txHash,
      rescreened: e.rescreened, tierFrom: e.tierFrom, tierTo: e.tierTo, webhooks: e.webhooks, handledAt: new Date(e.handledAt * 1000).toISOString(),
    })),
    anonymised: true,
    generatedAt: new Date().toISOString(),
  });
});
