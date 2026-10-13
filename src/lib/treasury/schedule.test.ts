import "../__tests__/setup";
delete process.env.TREASURY_MODE;
delete process.env.TREASURY_PRIVATE_KEY;
delete process.env.GUARDED_TREASURY_ADDRESS;

import { describe, it, expect, beforeAll } from "vitest";
import { planSchedule, QUIET_PERIOD_SECONDS, tierWithin } from "./schedule";
import { createInvoice, getInvoice, listTranches, migrateTreasury } from "./invoices";
import { runTreasuryOnce, type Executor } from "./agent";
import type { TreasuryPolicy, VerdictLike } from "./policy";
import { createEddRequest } from "../edd";
import { db } from "../store/db";
import { getDecision } from "../ledger";
import type { Address, Tier, Verdict } from "../types";

const NOW = 1_800_000_000;
const policy: TreasuryPolicy = { maxTier: "MEDIUM", perPayoutCapUsdc: 25, dailyCapUsdc: 1_000, requireAttestationOnChain: false };

function vl(tier: Tier, over: Partial<VerdictLike & { edd?: { id: string } | null; screenedAt?: number }> = {}) {
  return {
    address: "0x000000000000000000000000000000000000beef" as Address, tier, score: tier === "MEDIUM" ? 40 : tier === "LOW" ? 5 : 90, decisionId: "dec_x", rationale: "r",
    recommendedLimits: { maxPerTxUsdc: 250, maxPerDayUsdc: 1000 }, attestation: { validUntil: NOW + 3600, registryTx: null }, screenedAt: NOW, ...over,
  };
}

describe("planSchedule (pure)", () => {
  it("MEDIUM: 1/3 now (≤ limit), 1/3 after EDD answered, rest after 7 quiet days", () => {
    const s = planSchedule({ amountUsdc: 60 }, vl("MEDIUM", { edd: { id: "edd_1" } }), policy, { now: NOW })!;
    expect(s.limitUsdc).toBe(25);
    expect(s.tranches.map((t) => [t.n, t.amountUsdc, t.dueCondition.kind])).toEqual([[1, 20, "now"], [2, 20, "edd_answered"], [3, 20, "quiet_period"]]);
    expect(s.tranches[1].dueCondition).toMatchObject({ kind: "edd_answered", eddId: "edd_1", maxTier: "MEDIUM" });
    expect(s.tranches[2].dueCondition).toMatchObject({ kind: "quiet_period", until: NOW + QUIET_PERIOD_SECONDS, plannedTier: "MEDIUM" });
    expect(s.unscheduledUsdc).toBe(0);
  });
  it("the per-tranche limit (analyst per-tx ∧ per-payout cap) binds; anything above 3× limit stays unscheduled", () => {
    const s = planSchedule({ amountUsdc: 120 }, vl("MEDIUM", { edd: { id: "edd_1" } }), policy, { now: NOW })!;
    expect(s.tranches.map((t) => t.amountUsdc)).toEqual([25, 25, 25]);
    expect(s.unscheduledUsdc).toBe(45);
    const a = planSchedule({ amountUsdc: 120 }, vl("MEDIUM", { edd: { id: "edd_1" }, recommendedLimits: { maxPerTxUsdc: 10, maxPerDayUsdc: 100 } }), policy, { now: NOW })!;
    expect(a.limitUsdc).toBe(10);
    expect(a.tranches.map((t) => t.amountUsdc)).toEqual([10, 10, 10]);
  });
  it("without an EDD request tranche 2 waits for the quiet period too", () => {
    const s = planSchedule({ amountUsdc: 9 }, vl("MEDIUM", { edd: null }), policy, { now: NOW })!;
    expect(s.tranches.map((t) => [t.amountUsdc, t.dueCondition.kind])).toEqual([[3, "now"], [3, "quiet_period"], [3, "quiet_period"]]);
  });
  it("LOW / HIGH / incident policy → no schedule", () => {
    expect(planSchedule({ amountUsdc: 60 }, vl("LOW"), policy)).toBeNull();
    expect(planSchedule({ amountUsdc: 60 }, vl("HIGH"), policy)).toBeNull();
    expect(planSchedule({ amountUsdc: 60 }, vl("MEDIUM"), { ...policy, maxTier: "LOW" })).toBeNull();
    expect(planSchedule({ amountUsdc: 0 }, vl("MEDIUM"), policy)).toBeNull();
  });
  it("tierWithin", () => {
    expect(tierWithin("LOW", "MEDIUM")).toBe(true); expect(tierWithin("MEDIUM", "MEDIUM")).toBe(true); expect(tierWithin("HIGH", "MEDIUM")).toBe(false);
  });
});

// ── tick progression with a mocked screen ──────────────────────────────────
let nextTier: Tier = "MEDIUM";
let eddId: string | null = null;
let screens = 0;
const PAYEE = "0x00000000000000000000000000000000000beef1" as Address;
const PAYEE2 = "0x00000000000000000000000000000000000beef2" as Address;
function mockVerdict(address: Address, tier: Tier): Verdict {
  screens++;
  const dh = `0x${(screens + 100).toString(16).padStart(64, "0")}` as `0x${string}`;
  return {
    address, score: tier === "MEDIUM" ? 40 : tier === "LOW" ? 5 : 90, tier, recommendedLimits: { maxPerTxUsdc: 250, maxPerDayUsdc: 1000 }, reasons: [], rationale: `mock ${tier}`,
    eddRequested: [], nextRescreenAt: new Date((NOW + 86400) * 1000).toISOString(), decisionId: `dec_mock${screens}`, screenedAt: new Date(NOW * 1000).toISOString(),
    attestation: {
      typedData: { domain: { name: "CompliR", version: "1", chainId: 5042, verifyingContract: "0x0000000000000000000000000000000000000000" }, types: { Attestation: [] }, primaryType: "Attestation",
        message: { subject: address, tier: 2, score: 40, decisionHash: dh, issuedAt: NOW, validUntil: NOW + 100 * 86400 } },
      signature: "0x00", attester: "0x0000000000000000000000000000000000000001", validUntil: NOW + 100 * 86400, registryTx: null,
    },
    evidence: { subject: { address, firstSeen: null, txCount: 0, usdcBlacklisted: false, protocolBlocklisted: false, sanctions: [] }, funders: [], lookalikes: [], payeeChanged: null, concentration: null, priorTier: null, collectedAt: NOW, depth: 1 },
    edd: eddId ? { id: eddId, url: `http://x/edd/${eddId}` } : null,
  };
}
const screenFn = (async (req: { address: Address }) => mockVerdict(req.address, nextTier)) as unknown as typeof import("../pipeline").screen;
const executed: { payee: Address; amount: number; tranche?: number; decisionHash: string }[] = [];
const executor: Executor = async (payee, amount, ctx) => { executed.push({ payee, amount, tranche: ctx.tranche, decisionHash: ctx.verdict.attestation.typedData.message.decisionHash }); return `0x${executed.length.toString(16).padStart(64, "0")}` as `0x${string}`; };

describe("tick: schedule progression", () => {
  beforeAll(async () => { await migrateTreasury(); });

  it("MEDIUM invoice → SCHEDULED with tranche 1 released through the executor (decisionHash carried)", async () => {
    const edd = await createEddRequest({ subject: PAYEE, decisionId: "dec_seed", questions: ["Who are you?"] });
    eddId = edd.id;
    const inv = await createInvoice({ payee: PAYEE, label: "Nova - milestone", amountUsdc: 60 });
    const r = await runTreasuryOnce({ screenFn, executor, policy, now: NOW, seed: false });
    const x = r.results.find((y) => y.invoiceId === inv.id)!;
    expect(x).toMatchObject({ status: "SCHEDULED", paidUsdc: 20, heldUsdc: 40, schedule: { released: 1, total: 3 } });
    expect(executed).toEqual([{ payee: PAYEE, amount: 20, tranche: 1, decisionHash: x.decisionHash }]);
    expect((await listTranches(inv.id)).map((t) => t.status)).toEqual(["RELEASED", "PENDING", "PENDING"]);
    const payout = await getDecision(x.payoutDecisionId!);
    expect((payout?.payload as { schedule: { of: number }; release: { function: string } }).schedule.of).toBe(3);
    expect((payout?.payload as { release: { function: string; decisionHash: string } }).release).toEqual({ function: "releaseWithProof", decisionHash: x.decisionHash });
  });

  it("tranche 2 waits for the EDD answer; once ANSWERED and re-screen ≤ MEDIUM it is released", async () => {
    const inv = (await db().execute({ sql: `SELECT id FROM treasury_invoices WHERE payee = ?`, args: [PAYEE] })).rows[0]!.id as string;
    let r = await runTreasuryOnce({ screenFn, executor, policy, now: NOW + 60, seed: false });
    expect(r.tranches.filter((t) => t.invoiceId === inv).map((t) => [t.n, t.status])).toEqual([[2, "PENDING"], [3, "PENDING"]]);
    expect(r.tranches.find((t) => t.n === 2)!.note).toMatch(/waiting for the counterparty to answer EDD/);
    expect(executed).toHaveLength(1);

    await db().execute({ sql: `UPDATE edd_requests SET status='ANSWERED', answered_at=? WHERE id=?`, args: [NOW + 100, eddId] });
    r = await runTreasuryOnce({ screenFn, executor, policy, now: NOW + 120, seed: false });
    const t2 = r.tranches.find((t) => t.invoiceId === inv && t.n === 2)!;
    expect(t2.status).toBe("RELEASED");
    expect(t2.note).toMatch(/EDD .* answered/);
    expect(executed[1]).toMatchObject({ payee: PAYEE, amount: 20, tranche: 2 });
    expect(executed[1].decisionHash).not.toBe(executed[0].decisionHash); // paid against the fresh RESCREEN verdict
    const after = (await getInvoice(inv))!;
    expect(after).toMatchObject({ status: "SCHEDULED", paidUsdc: 40, heldUsdc: 20 });
    expect(after.reason).toMatch(/2\/3 tranches released/);
    expect(after.txHash).toBe(executed.length === 2 ? `0x${"2".padStart(64, "0")}` : after.txHash);
    expect(r.tranches.find((t) => t.invoiceId === inv && t.n === 3)!.status).toBe("PENDING");
  });

  it("tranche 3 is released after 7 quiet days with the tier still ≤ MEDIUM; the invoice becomes PAID", async () => {
    const inv = (await db().execute({ sql: `SELECT id FROM treasury_invoices WHERE payee = ?`, args: [PAYEE] })).rows[0]!.id as string;
    nextTier = "LOW"; // improved - still within MEDIUM
    const r = await runTreasuryOnce({ screenFn, executor, policy, now: NOW + QUIET_PERIOD_SECONDS + 1, seed: false });
    expect(r.tranches.find((t) => t.invoiceId === inv && t.n === 3)).toMatchObject({ status: "RELEASED", amountUsdc: 20 });
    expect(executed).toHaveLength(3);
    const after = (await getInvoice(inv))!;
    expect(after).toMatchObject({ status: "PAID", paidUsdc: 60, heldUsdc: 0, action: "PAY" });
    expect((await listTranches(inv)).every((t) => t.status === "RELEASED")).toBe(true);
  });

  it("a HIGH re-grade cancels every pending tranche and the invoice settles as LIMITED", async () => {
    nextTier = "MEDIUM"; eddId = null;
    const inv = await createInvoice({ payee: PAYEE2, label: "Unknown - retainer", amountUsdc: 30 });
    let r = await runTreasuryOnce({ screenFn, executor, policy, now: NOW, seed: false });
    expect(r.results.find((y) => y.invoiceId === inv.id)).toMatchObject({ status: "SCHEDULED", paidUsdc: 10 });
    const before = executed.length;

    nextTier = "HIGH";
    r = await runTreasuryOnce({ screenFn, executor, policy, now: NOW + QUIET_PERIOD_SECONDS + 1, seed: false });
    const mine = r.tranches.filter((t) => t.invoiceId === inv.id);
    expect(mine.map((t) => [t.n, t.status])).toEqual([[2, "CANCELLED"], [3, "CANCELLED"]]);
    expect(mine[0].note).toMatch(/re-screened HIGH/);
    expect(executed).toHaveLength(before); // nothing more left the treasury
    const after = (await getInvoice(inv.id))!;
    expect(after).toMatchObject({ status: "LIMITED", paidUsdc: 10, heldUsdc: 20, action: "LIMIT" });
    expect(after.reason).toMatch(/^SCHEDULE CANCELLED after 10 USDC/);
    expect((await listTranches(inv.id)).map((t) => t.status)).toEqual(["RELEASED", "CANCELLED", "CANCELLED"]);
    const payout = await getDecision(after.payoutDecisionId!);
    expect((payout?.payload as { tranchesCancelled: number; action: string }).tranchesCancelled).toBe(2);
  });

  it("a tranche bound by the daily cap simply waits (stays PENDING with the reason)", async () => {
    nextTier = "MEDIUM"; eddId = null;
    const inv = await createInvoice({ payee: PAYEE, label: "Nova - follow-up", amountUsdc: 30 });
    const tight: TreasuryPolicy = { ...policy, dailyCapUsdc: 15 };
    let r = await runTreasuryOnce({ screenFn, executor, policy: tight, now: NOW + 40 * 86400, seed: false }); // a new day
    expect(r.results.find((y) => y.invoiceId === inv.id)).toMatchObject({ status: "SCHEDULED", paidUsdc: 10 });
    r = await runTreasuryOnce({ screenFn, executor, policy: tight, now: NOW + 48 * 86400, seed: false }); // quiet period over, 10 of 15 spent that day? no - fresh day, 15 headroom: tranche 2 (10) pays, tranche 3 (10) waits
    const mine = r.tranches.filter((t) => t.invoiceId === inv.id);
    expect(mine.map((t) => [t.n, t.status])).toEqual([[2, "RELEASED"], [3, "PENDING"]]);
    expect(mine[1].note).toMatch(/waiting: LIMITED to 5 USDC by daily cap 15 USDC/);
    expect((await getInvoice(inv.id))!.status).toBe("SCHEDULED");
  });
});
