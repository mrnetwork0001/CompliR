import "../__tests__/setup";
process.env.TIP_BOUNTY_USDC = "0.25";
process.env.TIPS_DAILY_CAP_USDC = "0.6";
delete process.env.TIPS_PAYOUT_PRIVATE_KEY;
delete process.env.CIRCLE_API_KEY;
delete process.env.CIRCLE_ENTITY_SECRET;

import { describe, it, expect, beforeAll } from "vitest";
import type { Address, ScreenRequest, Tier, Verdict } from "../types";
import { getDecision, listDecisions, verifyChain } from "../ledger";
import {
  bountyFor, checkUrls, decide, getStats, getTip, migrateTips, payTip, payoutStatus, receiptInvolves, reputationOf, reviewTip, runTipsOnce, spentToday,
  submitTip, tipEvidenceFor, toPublicTip, verifyTip, type ReceiptClient, type ScreenFn, type Tip, type Transfer,
} from "./index";

const NOW = 1_800_000_000;
const DEAD = "0x000000000000000000000000000000000000dead" as Address;
const BEEF = "0x000000000000000000000000000000000000beef" as Address;
const CAFE = "0x000000000000000000000000000000000000cafe" as Address;
const TX1 = `0x${"11".repeat(32)}` as `0x${string}`;
const TX2 = `0x${"22".repeat(32)}` as `0x${string}`;
const PAYER = "0x00000000000000000000000000000000000a11ce";

/** Tier by subject: dead → HIGH, beef → MEDIUM, everything else LOW. */
const screenFn: ScreenFn = async (req: ScreenRequest) => {
  const tier: Tier = req.address === DEAD ? "HIGH" : req.address === BEEF ? "MEDIUM" : "LOW";
  const score = { HIGH: 92, MEDIUM: 38, LOW: 4 }[tier];
  return {
    address: req.address, score, tier, reasons: tier === "HIGH" ? [{ code: "SANCTIONS_DIRECT", weight: 100, evidence: { secret: "client-data-must-not-leak" } }] : [],
    decisionId: `dec_mock_${req.address.slice(-4)}`, recommendedLimits: { maxPerTxUsdc: 0, maxPerDayUsdc: 0 }, rationale: "mock", eddRequested: [],
    nextRescreenAt: new Date().toISOString(), screenedAt: new Date().toISOString(),
    attestation: { typedData: {} as never, signature: "0x", attester: "0x" as Address, validUntil: 0, registryTx: null },
    evidence: {} as never,
  } satisfies Verdict;
};
/** TX1 exists and pays the subject (Transfer topic), TX2 exists but is unrelated, anything else is unknown. */
const client: ReceiptClient = {
  getTransactionReceipt: (async ({ hash }: { hash: `0x${string}` }) => {
    if (hash === TX1) return { from: "0x0000000000000000000000000000000000000001", to: "0x3600000000000000000000000000000000000000", blockNumber: 100n, logs: [{ address: "0x3600000000000000000000000000000000000000", topics: ["0xddf2", `0x${"0".repeat(24)}${"0".repeat(39)}1`, `0x${"0".repeat(24)}${"0".repeat(36)}dead`] }] };
    if (hash === TX2) return { from: "0x0000000000000000000000000000000000000002", to: "0x0000000000000000000000000000000000000003", blockNumber: 101n, logs: [] };
    throw new Error("TransactionReceiptNotFoundError");
  }) as unknown as ReceiptClient["getTransactionReceipt"],
};
const tipOf = (over: Partial<Tip>): Tip => ({
  id: "tip_x", subject: CAFE, category: "scam", claim: "test claim long enough", evidenceUrls: [], evidenceTxs: [], submitter: PAYER, stakeUsdc: 0.05, stakeTx: "0xstake",
  status: "SUBMITTED", verification: null, payoutUsdc: 0, payoutTx: null, payoutMode: null, ledger: {}, createdAt: NOW, decidedAt: null, paidAt: null, ...over,
});

describe("corroboration + decision matrix", () => {
  it("URL allowlist: OFAC / OpenSanctions / EU / UK are strong, others weak, garbage is weak", () => {
    const r = checkUrls(["https://sanctionssearch.ofac.treas.gov/Details.aspx?id=1", "https://www.opensanctions.org/entities/x/", "https://eur-lex.europa.eu/x", "https://www.gov.uk/x", "https://medium.com/post", "not a url"]);
    expect(r.map((u) => u.strong)).toEqual([true, true, true, true, false, false]);
    expect(r[5].domain).toBeNull();
  });
  it("receiptInvolves: from/to, log emitter, indexed topic", () => {
    expect(receiptInvolves({ from: DEAD, to: null, logs: [] }, DEAD)).toBe(true);
    expect(receiptInvolves({ from: CAFE, to: DEAD, logs: [] }, DEAD)).toBe(true);
    expect(receiptInvolves({ from: CAFE, to: CAFE, logs: [{ address: CAFE, topics: [`0x${"0".repeat(24)}${DEAD.slice(2)}`] }] }, DEAD)).toBe(true);
    expect(receiptInvolves({ from: CAFE, to: CAFE, logs: [] }, DEAD)).toBe(false);
  });
  it("decide(): HIGH → VERIFIED; LOW+nothing → REJECTED; MEDIUM+strong → VERIFIED; MEDIUM alone / LOW+weak / no screen → NEEDS_REVIEW", () => {
    expect(decide("HIGH", 0, 0).decision).toBe("VERIFIED");
    expect(decide("LOW", 0, 0).decision).toBe("REJECTED");
    expect(decide("MEDIUM", 1, 0).decision).toBe("VERIFIED");
    expect(decide("MEDIUM", 0, 0).decision).toBe("NEEDS_REVIEW");
    expect(decide("MEDIUM", 0, 2).decision).toBe("NEEDS_REVIEW");
    expect(decide("LOW", 0, 1).decision).toBe("NEEDS_REVIEW");
    expect(decide("LOW", 1, 0).decision).toBe("NEEDS_REVIEW");
    expect(decide(null, 3, 0).decision).toBe("NEEDS_REVIEW");
  });
  it("verifyTip: HIGH re-screen → VERIFIED, never leaks evidence/client data", async () => {
    const v = await verifyTip(tipOf({ subject: DEAD }), { screenFn, client, now: NOW });
    expect(v).toMatchObject({ decision: "VERIFIED", tier: "HIGH", score: 92, decisionId: "dec_mock_dead", by: "agent", verifiedAt: NOW });
    expect(v.reasonCodes).toEqual(["SANCTIONS_DIRECT"]);
    expect(JSON.stringify(v)).not.toContain("client-data-must-not-leak");
  });
  it("verifyTip: LOW with no corroboration → REJECTED; MEDIUM alone → NEEDS_REVIEW; MEDIUM + strong URL → VERIFIED", async () => {
    expect((await verifyTip(tipOf({ subject: CAFE }), { screenFn, client, now: NOW })).decision).toBe("REJECTED");
    expect((await verifyTip(tipOf({ subject: BEEF }), { screenFn, client, now: NOW })).decision).toBe("NEEDS_REVIEW");
    const v = await verifyTip(tipOf({ subject: BEEF, category: "sanctions", evidenceUrls: ["https://www.opensanctions.org/entities/Q1/"] }), { screenFn, client, now: NOW });
    expect(v.decision).toBe("VERIFIED");
    expect(v.corroboration).toMatchObject({ strong: 1, weak: 0 });
  });
  it("verifyTip: tx receipts - involving the subject is strong, unrelated is weak, unknown counts nothing", async () => {
    const v = await verifyTip(tipOf({ subject: DEAD, evidenceTxs: [TX1, TX2, `0x${"33".repeat(32)}`] }), { screenFn, client, now: NOW });
    expect(v.corroboration.txs.map((t) => [t.found, t.involvesSubject])).toEqual([[true, true], [true, false], [false, false]]);
    expect(v.corroboration).toMatchObject({ strong: 1, weak: 1 });
    const medium = await verifyTip(tipOf({ subject: BEEF, evidenceTxs: [TX2] }), { screenFn, client, now: NOW });
    expect(medium.decision).toBe("NEEDS_REVIEW"); // weak only
  });
  it("verifyTip: screen failure → NEEDS_REVIEW with the error recorded", async () => {
    const v = await verifyTip(tipOf({ subject: CAFE }), { screenFn: async () => { throw new Error("yente down"); }, client: null, now: NOW });
    expect(v.decision).toBe("NEEDS_REVIEW");
    expect(v.error).toBe("yente down");
  });
});

describe("bounty + reputation", () => {
  it("reputation is Laplace-smoothed verified/(verified+rejected)", () => {
    expect(reputationOf(0, 0)).toBe(0.5);
    expect(reputationOf(3, 0)).toBe(0.8);
    expect(reputationOf(0, 3)).toBe(0.2);
    expect(reputationOf(98, 0)).toBe(0.99);
  });
  it("bounty = base × category × (0.5 + 0.5·rep)", () => {
    expect(bountyFor("other", 0.5, 0.25)).toBe(0.1875);
    expect(bountyFor("sanctions", 1, 0.25)).toBe(0.5);
    expect(bountyFor("sanctions", 0, 0.25)).toBe(0.25);
    expect(bountyFor("poisoning", 0.5, 0.25)).toBe(0.28125);
    expect(bountyFor("mixer", 2, 0.25)).toBe(0.25); // rep clamped to 1
    expect(bountyFor("scam", 0.5)).toBe(0.1875); // env TIP_BOUNTY_USDC=0.25
  });
});

describe("payout (dry-run) + daily cap", () => {
  beforeAll(async () => { await migrateTips(); });
  it("defaults to dry-run without Circle credentials or TIPS_PAYOUT_PRIVATE_KEY", () => {
    expect(payoutStatus().mode).toBe("dry-run");
  });
  it("payTip: demo submitter → recorded, not sent; payer address → transfer rail; cap defers", async () => {
    const sent: { to: Address; amount: number }[] = [];
    const transfer: Transfer = async (to, amount) => { sent.push({ to, amount }); return { mode: "dry-run", txHash: null }; };
    const a = await payTip(tipOf({ id: "tip_a", submitter: "demo", stakeUsdc: 0 }), 0.2, { transfer, now: NOW });
    expect(a).toMatchObject({ paid: true, mode: "dry-run", txHash: null, amountUsdc: 0.2 });
    expect(sent).toHaveLength(0);
    const b = await payTip(tipOf({ id: "tip_b" }), 0.3, { transfer, now: NOW });
    expect(b).toMatchObject({ paid: true, amountUsdc: 0.3 });
    expect(sent).toEqual([{ to: PAYER, amount: 0.3 }]);
    expect(await spentToday(NOW)).toBe(0.5);
    const c = await payTip(tipOf({ id: "tip_c" }), 0.2, { transfer, now: NOW }); // 0.5 + 0.2 > cap 0.6
    expect(c).toMatchObject({ paid: false, deferred: true });
    expect(sent).toHaveLength(1);
    const d = await payTip(tipOf({ id: "tip_d" }), 0.1, { transfer, now: NOW, dailyCapUsdc: 10 });
    expect(d.paid).toBe(true);
  });
});

describe("market tick: submit → verify → pay / slash, ledger TIP entries, oracle feedback", () => {
  const NOW2 = NOW + 86_400 * 2; // fresh day for the cap
  const transferLog: { to: Address; amount: number; refId: string }[] = [];
  const transfer: Transfer = async (to, amount, refId) => { transferLog.push({ to, amount, refId }); return { mode: "dry-run", txHash: null, note: "test rail" }; };
  const opts = { screenFn, client, transfer, now: NOW2 };

  it("end to end", async () => {
    const good = await submitTip({ subject: DEAD, category: "sanctions", claim: "This wallet is on the SDN list (demo).", evidenceUrls: ["https://sanctionssearch.ofac.treas.gov/"], evidenceTxs: [] }, { submitter: PAYER, stakeUsdc: 0.05, stakeTx: "0xstake1" });
    const bad = await submitTip({ subject: CAFE, category: "scam", claim: "I just do not like this address, honestly.", evidenceUrls: [], evidenceTxs: [] }, { submitter: PAYER, stakeUsdc: 0.05, stakeTx: "0xstake2" });
    const maybe = await submitTip({ subject: BEEF, category: "mixer", claim: "Looks like it touched a mixer last week.", evidenceUrls: [], evidenceTxs: [] }, { submitter: "demo", stakeUsdc: 0 });
    expect(good.status).toBe("SUBMITTED");
    expect(good.ledger.submit).toMatch(/^dec_/);
    expect((await getDecision(good.ledger.submit!))?.kind).toBe("TIP");
    expect((await getStats(PAYER))?.submitted).toBe(2);

    const r = await runTipsOnce(opts);
    expect(r).toMatchObject({ payoutMode: "dry-run", verified: 1, rejected: 1, needsReview: 1, paid: 0, recorded: 1, failed: 0, dropped: 0 });
    const by = Object.fromEntries(r.results.map((x) => [x.tipId, x]));
    // bounty: 0.25 × sanctions 2 × (0.5 + 0.5·0.5) = 0.375 for a new submitter
    expect(by[good.id]).toMatchObject({ status: "RECORDED", decision: "VERIFIED", tier: "HIGH", bountyUsdc: 0.375, payoutUsdc: 0.375, payoutMode: "dry-run", payoutTx: null }); // dry-run: recorded, not paid
    expect(by[bad.id]).toMatchObject({ status: "SLASHED", decision: "REJECTED", tier: "LOW" });
    expect(by[maybe.id]).toMatchObject({ status: "NEEDS_REVIEW", decision: "NEEDS_REVIEW", tier: "MEDIUM" });
    expect(transferLog).toEqual([{ to: PAYER, amount: 0.375, refId: `complir:tip:${good.id}` }]);

    // ledger: SUBMIT / VERIFY / PAY for the good tip, SUBMIT / VERIFY / SLASH for the bad one; chain intact
    const g = (await getTip(good.id))!;
    expect(Object.keys(g.ledger).sort()).toEqual(["pay", "submit", "verify"]);
    const pay = await getDecision(g.ledger.pay!);
    expect(pay?.kind).toBe("TIP");
    expect(pay?.subject).toBe(DEAD);
    expect(pay?.payload).toMatchObject({ type: "TIP", event: "PAY", tipId: good.id, amountUsdc: 0.375, simulated: true });
    expect((pay?.payload as { submitter: string }).submitter).toMatch(/^tipster-[0-9a-f]{6}$/); // anonymised in the public ledger
    const b = (await getTip(bad.id))!;
    expect(Object.keys(b.ledger).sort()).toEqual(["slash", "submit", "verify"]);
    expect((await getDecision(b.ledger.slash!))?.payload).toMatchObject({ event: "SLASH", slashedUsdc: 0.05, stakeTx: "0xstake2" });
    expect((await verifyChain()).ok).toBe(true);
    const tipEntries = (await listDecisions({ limit: 50 })).filter((e) => e.kind === "TIP");
    expect(tipEntries.length).toBeGreaterThanOrEqual(8);

    // stats + reputation
    const s = (await getStats(PAYER))!;
    expect(s).toMatchObject({ submitted: 2, verified: 1, rejected: 1, earnedUsdc: 0 /* dry-run: nothing sent, nothing earned */, reputation: 0.5 });

    // oracle feedback: only the VERIFIED tip is evidence
    const ev = await tipEvidenceFor(DEAD, { now: NOW2 });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ tipId: good.id, category: "sanctions", strength: "strong", tierAtVerification: "HIGH" });
    expect(await tipEvidenceFor(CAFE, { now: NOW2 })).toEqual([]);

    // public projection hides the payer address and the internals
    const pub = toPublicTip(g);
    expect(pub.submitter).toMatch(/^tipster-/);
    expect(JSON.stringify(pub)).not.toContain(PAYER);
    expect(pub.verdict).toMatchObject({ tier: "HIGH", decision: "VERIFIED", decisionId: "dec_mock_dead" });

    // human review of the NEEDS_REVIEW demo tip → VERIFIED → paid as dry-run (no payout address), reputation unchanged for demo
    const rv = await reviewTip(maybe.id, "VERIFIED", "checked the mixer trace", opts);
    expect(rv).toMatchObject({ status: "RECORDED", decision: "VERIFIED", payoutMode: "dry-run" });
    const m = (await getTip(maybe.id))!;
    expect(m.verification?.by).toBe("human");
    expect(m.ledger.review).toMatch(/^dec_/);
    expect(await tipEvidenceFor(BEEF, { now: NOW2 })).toHaveLength(1);
    expect(transferLog).toHaveLength(1); // demo submitter: nothing sent

    // idempotent: nothing left to do
    const again = await runTipsOnce(opts);
    expect(again.results).toHaveLength(0);
  }, 30_000);

  it("daily cap defers a VERIFIED payout to a later tick", async () => {
    const t = await submitTip({ subject: DEAD, category: "sanctions", claim: "Second sanctions tip about the same wallet.", evidenceUrls: [], evidenceTxs: [] }, { submitter: PAYER, stakeUsdc: 0.05, stakeTx: "0xstake3" });
    // PAYER rep after 1 verified / 1 rejected = 0.5 → 0.375; already spent 0.375 today of cap 0.6 → deferred
    const r = await runTipsOnce(opts);
    const x = r.results.find((y) => y.tipId === t.id)!;
    expect(x).toMatchObject({ status: "VERIFIED", decision: "VERIFIED", bountyUsdc: 0.375, payoutTx: null });
    expect(x.note).toMatch(/daily cap/);
    expect(r.deferred).toBe(1);
    // next day: paid
    const r2 = await runTipsOnce({ ...opts, now: NOW2 + 86_400 });
    expect(r2.results.find((y) => y.tipId === t.id)).toMatchObject({ status: "RECORDED", payoutUsdc: 0.375 });
    expect((await getTip(t.id))?.status).toBe("RECORDED");
  }, 30_000);

  it("an API tip whose stake never settles is dropped after the grace period, without a slash", async () => {
    const t = await submitTip({ subject: DEAD, category: "other", claim: "Unpaid stake should not be verified.", evidenceUrls: [], evidenceTxs: [] }, { submitter: "0x0000000000000000000000000000000000000b0b", stakeUsdc: 0.05, stakeTx: null });
    const real = Math.floor(Date.now() / 1000); // createdAt is wall-clock; the grace window is measured from it
    const r1 = await runTipsOnce({ ...opts, now: real + 10 });
    expect(r1.results.find((y) => y.tipId === t.id)).toBeUndefined(); // still waiting
    const r2 = await runTipsOnce({ ...opts, now: real + 10_000 });
    expect(r2.results.find((y) => y.tipId === t.id)).toMatchObject({ status: "REJECTED" });
    expect(r2.dropped).toBe(1);
    expect((await getTip(t.id))?.ledger.slash).toBeUndefined();
  }, 30_000);
});
