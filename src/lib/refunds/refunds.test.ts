import "../__tests__/setup";
delete process.env.CIRCLE_API_KEY;
delete process.env.CIRCLE_ENTITY_SECRET;
delete process.env.REFUND_PRIVATE_KEY;
delete process.env.REVENUE_PRIVATE_KEY;
delete process.env.REFUND_DAILY_CAP_USDC;

import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetConfig } from "../config";
import { __resetDb, db } from "../store/db";
import { recordPayment } from "../store/repo";
import { listDecisions } from "../ledger";
import { __resetPay, type RefundSink } from "../pay/x402";
import { __resetRefunds, __resetRefundSink, getRefund, installRefundSink, listRefunds, processRefunds, queueRefund, refundMode, refundedTodayUsdc, requeueRefund, type RefundSender } from "./index";

const PAYER = "0x857b06519e91e3a54538791bdbb0e22373e36b66";
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

beforeEach(() => {
  __resetDb(); __resetRefunds(); __resetConfig(); __resetPay(); __resetRefundSink();
  delete process.env.REFUND_DAILY_CAP_USDC;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("queueRefund", () => {
  it("is idempotent per original tx", async () => {
    const a = await queueRefund({ payer: PAYER, amountUsdc: 0.01, reason: "handler failed", originalTx: tx(1), endpoint: "/api/v1/screen" });
    const b = await queueRefund({ payer: PAYER, amountUsdc: 0.01, reason: "duplicate", originalTx: tx(1) });
    expect(a.created).toBe(true); expect(b.created).toBe(false);
    expect(b.refund.id).toBe(a.refund.id);
    expect(b.refund.reason).toBe("handler failed");
    expect(await listRefunds()).toHaveLength(1);
  });
  it("allows several manual refunds without an original tx and validates input", async () => {
    await queueRefund({ payer: PAYER, amountUsdc: "0.003", reason: "goodwill", source: "manual" });
    await queueRefund({ payer: PAYER, amountUsdc: 0.004, reason: "goodwill 2", source: "manual" });
    expect(await listRefunds()).toHaveLength(2);
    await expect(queueRefund({ payer: "nope", amountUsdc: 1, reason: "x" })).rejects.toThrow(/payer/);
    await expect(queueRefund({ payer: PAYER, amountUsdc: 0, reason: "x" })).rejects.toThrow(/amountUsdc/);
  });
});

describe("processRefunds", () => {
  it("DRY_RUN with a clear reason when neither Circle nor a local key is configured; nothing marked refunded", async () => {
    expect(refundMode().mode).toBe("dry-run");
    await recordPayment({ txHash: tx(2), payer: PAYER, amountUsdc: 0.01, endpoint: "/api/v1/screen" });
    const { refund } = await queueRefund({ payer: PAYER, amountUsdc: 0.01, reason: "handler failed", originalTx: tx(2) });
    const r = await processRefunds();
    expect(r).toMatchObject({ processed: 1, dryRun: 1, sent: 0, mode: "dry-run" });
    const row = (await getRefund(refund.id))!;
    expect(row.status).toBe("DRY_RUN");
    expect(row.note).toMatch(/no refund signer/);
    expect(row.ledgerId).toBeTruthy();
    const paid = await db().execute({ sql: `SELECT refunded FROM payments WHERE tx_hash = ?`, args: [tx(2)] });
    expect(Number((paid.rows[0] as Record<string, unknown>).refunded)).toBe(0);
    const led = (await listDecisions({ limit: 5 })).find((d) => d.kind === "REFUND")!;
    expect(led.payload).toMatchObject({ type: "REFUND", payer: PAYER, amount: 0.01, originalTx: tx(2), refundTx: null, status: "DRY_RUN", simulated: true });
    // a signer shows up later → requeue → sent
    const send: RefundSender = async () => ({ status: "sent", txHash: tx(99), via: "local" });
    expect((await requeueRefund(refund.id))!.status).toBe("QUEUED");
    expect(await processRefunds({ send })).toMatchObject({ sent: 1 });
    expect((await getRefund(refund.id))!.txHash).toBe(tx(99));
  });

  it("SENT: marks the original payment refunded, appends ledger REFUND with the refund tx, counts toward today's total", async () => {
    await recordPayment({ txHash: tx(3), payer: PAYER, amountUsdc: 0.05, endpoint: "/api/v1/watch" });
    const { refund } = await queueRefund({ payer: PAYER, amountUsdc: 0.05, reason: "watch registration failed", originalTx: tx(3) });
    const send = vi.fn<RefundSender>(async () => ({ status: "sent", txHash: tx(42), via: "circle" }));
    const r = await processRefunds({ send });
    expect(r).toMatchObject({ sent: 1, sentUsdc: 0.05 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: refund.id, payer: PAYER, amountUsdc: 0.05 }));
    const row = (await getRefund(refund.id))!;
    expect(row).toMatchObject({ status: "SENT", txHash: tx(42) });
    expect(row.sentAt).toBeTruthy();
    const paid = await db().execute({ sql: `SELECT refunded FROM payments WHERE tx_hash = ?`, args: [tx(3)] });
    expect(Number((paid.rows[0] as Record<string, unknown>).refunded)).toBe(1);
    const led = (await listDecisions({ limit: 5 })).find((d) => d.kind === "REFUND")!;
    expect(led.subject).toBe(PAYER);
    expect(led.payload).toMatchObject({ payer: PAYER, amount: 0.05, reason: "watch registration failed", originalTx: tx(3), refundTx: tx(42), status: "SENT" });
    expect(await refundedTodayUsdc()).toBe(0.05);
    // second tick: nothing left, no double send
    expect(await processRefunds({ send })).toMatchObject({ processed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("respects REFUND_DAILY_CAP_USDC: beyond the cap refunds stay QUEUED and are flagged", async () => {
    process.env.REFUND_DAILY_CAP_USDC = "0.025";
    for (let i = 1; i <= 4; i++) await queueRefund({ payer: PAYER, amountUsdc: 0.01, reason: `r${i}`, originalTx: tx(10 + i) });
    let n = 0;
    const send: RefundSender = async () => ({ status: "sent", txHash: tx(100 + ++n), via: "local" });
    const r = await processRefunds({ send });
    expect(r).toMatchObject({ processed: 4, sent: 2, capped: 2, sentUsdc: 0.02 });
    const rows = await listRefunds();
    expect(rows.filter((x) => x.status === "SENT")).toHaveLength(2);
    const queued = rows.filter((x) => x.status === "QUEUED");
    expect(queued).toHaveLength(2);
    for (const q of queued) expect(q.note).toMatch(/OVER_DAILY_CAP/);
    // raising the cap drains the rest
    process.env.REFUND_DAILY_CAP_USDC = "5";
    expect(await processRefunds({ send })).toMatchObject({ sent: 2, capped: 0 });
  });

  it("retries transient send errors and gives up after REFUND_MAX_ATTEMPTS", async () => {
    process.env.REFUND_MAX_ATTEMPTS = "2";
    const { refund } = await queueRefund({ payer: PAYER, amountUsdc: 0.01, reason: "x", originalTx: tx(7) });
    const send: RefundSender = async () => { throw new Error("rpc down"); };
    expect(await processRefunds({ send })).toMatchObject({ retained: 1, failed: 0 });
    expect((await getRefund(refund.id))!.status).toBe("QUEUED");
    expect(await processRefunds({ send })).toMatchObject({ failed: 1 });
    expect((await getRefund(refund.id))!).toMatchObject({ status: "FAILED", attempts: 2 });
    delete process.env.REFUND_MAX_ATTEMPTS;
  });
});

describe("installRefundSink", () => {
  it("queues a refund from the x402 event (idempotent install)", async () => {
    process.env.REFUND_AUTO_PROCESS = "0";
    // the sink registered inside x402 is private: capture what installRefundSink() hands to setRefundSink
    const mod = await import("../pay/x402");
    let captured: RefundSink | null = null;
    const spy = vi.spyOn(mod, "setRefundSink").mockImplementation((fn) => { captured = fn; });
    installRefundSink(); installRefundSink();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(captured).toBeTruthy();
    await captured!({ payer: PAYER, amountUsdc: "0.01", settleTxHash: tx(8), endpoint: "/api/v1/screen", network: "eip155:5042", reason: "handler error", at: Date.now() });
    const rows = await listRefunds();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ payer: PAYER, amountUsdc: 0.01, originalTx: tx(8), source: "auto", status: "QUEUED" });
    spy.mockRestore();
    delete process.env.REFUND_AUTO_PROCESS;
  });
});
