import "../__tests__/setup";
process.env.REFUND_AUTO_PROCESS = "0";
process.env.GUARANTEE_MAX_BOND_USDC = "0.5";

import { describe, it, expect, beforeAll } from "vitest";
import { attachGuarantee, claimGuarantee, claimantMatches, getGuarantee, guaranteeConfig, GuaranteeError, migrateGuarantees, sizeBond, toPublicGuarantee } from "./index";
import { getDecision } from "../ledger";
import { db } from "../store/db";
import { recordPayment } from "../store";
import type { Address, ScreenRequest, Tier, Verdict } from "../types";

const NOW = 1_800_000_000;
const SUBJECT = "0x000000000000000000000000000000000000cafe" as Address;
const PAYER = "0x857b06519e91e3a54538791bdbb0e22373e36b66" as Address;
let n = 0;
function verdict(tier: Tier, over: Partial<Verdict> = {}): Verdict {
  n++;
  return {
    address: SUBJECT, score: tier === "LOW" ? 3 : 90, tier, recommendedLimits: { maxPerTxUsdc: 100, maxPerDayUsdc: 500 }, reasons: [], rationale: `mock ${tier}`,
    eddRequested: [], nextRescreenAt: new Date((NOW + 86400) * 1000).toISOString(), decisionId: `dec_g${n}`, screenedAt: new Date(NOW * 1000).toISOString(),
    attestation: {
      typedData: { domain: { name: "CompliR", version: "1", chainId: 5042, verifyingContract: "0x0000000000000000000000000000000000000000" }, types: { Attestation: [] }, primaryType: "Attestation",
        message: { subject: SUBJECT, tier: 1, score: 3, decisionHash: `0x${n.toString(16).padStart(64, "0")}`, issuedAt: NOW, validUntil: NOW + 30 * 86400 } },
      signature: "0x00", attester: "0x0000000000000000000000000000000000000001", validUntil: NOW + 30 * 86400, registryTx: null,
    },
    evidence: { subject: { address: SUBJECT, firstSeen: null, txCount: 0, usdcBlacklisted: false, protocolBlocklisted: false, sanctions: [] }, funders: [], lookalikes: [], payeeChanged: null, concentration: null, priorTier: null, collectedAt: NOW, depth: 1 },
    ...over,
  };
}
const cfg = guaranteeConfig();

describe("bond sizing", () => {
  it("min(max bond, 10 % of amount, 25 % of revenue balance)", () => {
    expect(sizeBond({ amountUsdc: 100, revenueBalanceUsdc: 100, cfg })).toBe(0.5); // max bond binds
    expect(sizeBond({ amountUsdc: 2, revenueBalanceUsdc: 100, cfg })).toBe(0.2); // 10 % of amount binds
    expect(sizeBond({ amountUsdc: 100, revenueBalanceUsdc: 1, cfg })).toBe(0.25); // 25 % of balance binds
    expect(sizeBond({ amountUsdc: 0.123456789, revenueBalanceUsdc: 100, cfg })).toBe(0.012346); // 6 dp
  });
  it("no bond when the balance is unreadable, zero, or there is no amount", () => {
    expect(sizeBond({ amountUsdc: 100, revenueBalanceUsdc: null, cfg })).toBe(0);
    expect(sizeBond({ amountUsdc: 100, revenueBalanceUsdc: 0, cfg })).toBe(0);
    expect(sizeBond({ amountUsdc: 0, revenueBalanceUsdc: 100, cfg })).toBe(0);
  });
  it("GUARANTEE_MAX_BOND_USDC / GUARANTEE_DAYS from env with sane defaults", () => {
    expect(guaranteeConfig({})).toMatchObject({ maxBondUsdc: 0.5, days: 30 });
    expect(guaranteeConfig({ GUARANTEE_MAX_BOND_USDC: "0.2", GUARANTEE_DAYS: "7" })).toMatchObject({ maxBondUsdc: 0.2, days: 7 });
    expect(guaranteeConfig({ GUARANTEE_MAX_BOND_USDC: "nope" }).maxBondUsdc).toBe(0.5);
  });
});

describe("attach + claim", () => {
  beforeAll(async () => { await migrateGuarantees(); });

  it("LOW + amountUsdc → guarantee persisted and returned; until = screenedAt + 30 days", async () => {
    const v = verdict("LOW");
    const g = await attachGuarantee(v, { amountUsdc: 40, clientId: PAYER }, { balance: async () => 10, now: NOW });
    expect(g).toEqual({ bondUsdc: 0.5, until: new Date((NOW + 30 * 86400) * 1000).toISOString(), terms: expect.stringContaining("claim 0.5 USDC back") });
    expect(g!.terms).toMatch(/not insurance/);
    const row = (await getGuarantee(v.decisionId))!;
    expect(row).toMatchObject({ subject: SUBJECT, payer: PAYER, amountUsdc: 40, bondUsdc: 0.5, status: "ACTIVE", claim: null });
    expect(toPublicGuarantee(row).until).toBe(g!.until);
  });
  it("no guarantee for MEDIUM, for a screen without amount, or when the revenue balance is unreadable", async () => {
    expect(await attachGuarantee(verdict("HIGH"), { amountUsdc: 40 }, { balance: async () => 10 })).toBeNull();
    expect(await attachGuarantee(verdict("LOW"), {}, { balance: async () => 10 })).toBeNull();
    const v = verdict("LOW");
    expect(await attachGuarantee(v, { amountUsdc: 40 }, { balance: async () => null })).toBeNull();
    expect(await getGuarantee(v.decisionId)).toBeNull();
  });

  it("valid claim: subject re-screens HIGH → refund of the bond queued (reason guarantee …), GUARANTEE ledger entry, status CLAIMED", async () => {
    const v = verdict("LOW");
    await attachGuarantee(v, { amountUsdc: 40, clientId: PAYER }, { balance: async () => 10, now: NOW });
    const r = await claimGuarantee({ decisionId: v.decisionId, payerAddress: PAYER }, { screenFn: async (req: ScreenRequest) => { expect(req.address).toBe(SUBJECT); return verdict("HIGH"); }, now: NOW + 86400 });
    expect(r.guarantee.status).toBe("CLAIMED");
    expect(r.refund).toMatchObject({ amountUsdc: 0.5, payer: PAYER, status: "QUEUED" });
    expect(r.rescreen.tier).toBe("HIGH");
    const refund = (await db().execute({ sql: `SELECT * FROM refunds WHERE id = ?`, args: [r.refund.id] })).rows[0] as Record<string, unknown>;
    expect(String(refund.reason)).toMatch(/^guarantee dec_g\d+: subject 0x0000…?/);
    expect(refund.source).toBe("manual");
    expect(refund.endpoint).toBe("/api/v1/guarantee/claim");
    const entry = await getDecision(r.ledgerId);
    expect(entry?.kind).toBe("GUARANTEE");
    expect(entry?.payload).toMatchObject({ type: "GUARANTEE", event: "CLAIMED", decisionId: v.decisionId, bondUsdc: 0.5, refundId: r.refund.id });
    const after = (await getGuarantee(v.decisionId))!;
    expect(after.claim).toMatchObject({ payerAddress: PAYER, refundId: r.refund.id, rescreenTier: "HIGH" });
    // second claim → NOT_ACTIVE
    await expect(claimGuarantee({ decisionId: v.decisionId, payerAddress: PAYER }, { screenFn: async () => verdict("HIGH") })).rejects.toMatchObject({ code: "NOT_ACTIVE" });
  });

  it("invalid claim: subject still LOW → NOT_HIGH, stays ACTIVE, rejection on the ledger, no refund", async () => {
    const v = verdict("LOW");
    await attachGuarantee(v, { amountUsdc: 40, clientId: PAYER }, { balance: async () => 10, now: NOW });
    const before = Number((await db().execute(`SELECT COUNT(*) AS n FROM refunds`)).rows[0]!.n);
    await expect(claimGuarantee({ decisionId: v.decisionId, payerAddress: PAYER }, { screenFn: async () => verdict("LOW"), now: NOW + 10 })).rejects.toMatchObject({ code: "NOT_HIGH" });
    expect((await getGuarantee(v.decisionId))!.status).toBe("ACTIVE");
    expect(Number((await db().execute(`SELECT COUNT(*) AS n FROM refunds`)).rows[0]!.n)).toBe(before);
    const rej = (await db().execute({ sql: `SELECT payload FROM decisions WHERE kind='GUARANTEE' ORDER BY seq DESC LIMIT 1` })).rows[0]!;
    expect(JSON.parse(String(rej.payload))).toMatchObject({ event: "CLAIM_REJECTED", decisionId: v.decisionId });
  });

  it("expired claim → EXPIRED (and the row is marked)", async () => {
    const v = verdict("LOW");
    await attachGuarantee(v, { amountUsdc: 40, clientId: PAYER }, { balance: async () => 10, now: NOW });
    let screened = false;
    await expect(claimGuarantee({ decisionId: v.decisionId, payerAddress: PAYER }, { screenFn: async () => { screened = true; return verdict("HIGH"); }, now: NOW + 31 * 86400 })).rejects.toMatchObject({ code: "EXPIRED" });
    expect(screened).toBe(false);
    expect((await getGuarantee(v.decisionId))!.status).toBe("EXPIRED");
  });

  it("claimant must be the original payer: clientId match, an x402 payment record, or same-origin; otherwise 403", async () => {
    const v = verdict("LOW");
    await attachGuarantee(v, { amountUsdc: 40, clientId: "some-api-key" }, { balance: async () => 10, now: NOW });
    const other = "0x00000000000000000000000000000000000000aa" as Address;
    await expect(claimGuarantee({ decisionId: v.decisionId, payerAddress: other }, { screenFn: async () => verdict("HIGH"), now: NOW + 1 })).rejects.toMatchObject({ code: "CLAIMANT_MISMATCH" });
    expect((await getGuarantee(v.decisionId))!.status).toBe("ACTIVE");
    // an x402 payment by `other` for /api/v1/screen around the screen time binds it
    await recordPayment({ txHash: null, payer: other, amountUsdc: 0.01, endpoint: "/api/v1/screen" });
    expect(await claimantMatches((await getGuarantee(v.decisionId))!, other)).toBe(true);
    // same-origin (demo page) is accepted without a record
    const v2 = verdict("LOW");
    await attachGuarantee(v2, { amountUsdc: 40 }, { balance: async () => 10, now: NOW });
    const r = await claimGuarantee({ decisionId: v2.decisionId, payerAddress: "0x00000000000000000000000000000000000000bb", sameOrigin: true }, { screenFn: async () => verdict("HIGH"), now: NOW + 1 });
    expect(r.guarantee.status).toBe("CLAIMED");
  });

  it("unknown decision → NOT_FOUND; bad address → VALIDATION", async () => {
    await expect(claimGuarantee({ decisionId: "dec_nope", payerAddress: PAYER })).rejects.toBeInstanceOf(GuaranteeError);
    await expect(claimGuarantee({ decisionId: "dec_nope", payerAddress: PAYER })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(claimGuarantee({ decisionId: "dec_nope", payerAddress: "nope" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
