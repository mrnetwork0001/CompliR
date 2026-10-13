/**
 * GET  /api/v1/payouts - invoices + totals + mode/policy for the Guarded Payouts page. Free.
 * POST /api/v1/payouts - add an invoice { payee, label, amountUsdc, memo? }. Same-origin browsers only (403 otherwise):
 *                        this is the demo's own queue, not a public write endpoint.
 */
import { isSameOriginBrowser } from "@/lib/payments";
import { NewInvoiceSchema, createInvoice, ensureTreasury, invoiceTotals, listInvoices, tranchesByInvoice, treasuryStatus, type Invoice, type InvoiceTotals, type TrancheRow, type TreasuryStatus } from "@/lib/treasury";
import { handle, ok, error } from "../../_lib/respond";
import { parseJson } from "../../_lib/parse";

export interface PayoutsResponse {
  mode: TreasuryStatus["mode"];
  status: TreasuryStatus;
  totals: InvoiceTotals;
  items: Invoice[];
  /** tranche schedule per SCHEDULED (or formerly scheduled) invoice id - risk-aware routing for MEDIUM payees */
  tranches: Record<string, TrancheRow[]>;
  time: string;
}

export const GET = handle(async () => {
  await ensureTreasury();
  const [items, totals] = await Promise.all([listInvoices(200), invoiceTotals()]);
  const tranches = await tranchesByInvoice(items.map((i) => i.id));
  const status = treasuryStatus();
  const body: PayoutsResponse = { mode: status.mode, status, totals, items, tranches, time: new Date().toISOString() };
  return ok(body);
});

export const POST = handle(async (req: Request) => {
  if (!isSameOriginBrowser(req)) {
    return error("VALIDATION_ERROR", "Invoices can only be added from the CompliR payouts page (same-origin browser).", undefined, { status: 403 });
  }
  await ensureTreasury();
  const input = await parseJson(req, NewInvoiceSchema);
  const invoice = await createInvoice(input);
  return ok({ invoice }, { status: 201 });
});
