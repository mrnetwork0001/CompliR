/**
 * Glue between the x402 layer and the store: every settled payment lands in the `payments` table
 * (traction accounting, own wallets excluded on /numbers). Imported by the paid routes.
 */
import { setPaymentSink } from "./pay";
import { recordPayment } from "./store";
import { installRefundSink } from "./refunds";

let registered = false;
export function ensurePaymentSink(): void {
  if (registered) return;
  registered = true;
  installRefundSink(); // settled-but-undelivered → automatic on-chain refund (src/lib/refunds)
  setPaymentSink(async (e) => {
    await recordPayment({ txHash: e.txHash ?? null, payer: e.payer, amountUsdc: Number(e.amountUsdc), endpoint: e.endpoint });
  });
}

/**
 * The hosted Explorer stays free: browsers set `Sec-Fetch-Site: same-origin` on fetches from our own pages,
 * API clients (curl, SDKs, other agents) do not. Everything else pays via x402.
 */
export function isSameOriginBrowser(req: Request): boolean {
  return req.headers.get("sec-fetch-site") === "same-origin";
}
