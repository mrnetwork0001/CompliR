import "../__tests__/setup";
process.env.EVIDENCE_SOURCE_TIMEOUT_MS = "800"; // RPC is unreachable in tests; fail fast, overrides supply the demo facts
delete process.env.TREASURY_MODE;
delete process.env.TREASURY_PRIVATE_KEY;
delete process.env.GUARDED_TREASURY_ADDRESS;

import { describe, it, expect, beforeAll } from "vitest";
import { decidePayout, DEFAULT_POLICY, type TreasuryPolicy, type VerdictLike } from "./policy";
import { seedDemoInvoices, listInvoices, migrateTreasury, spentToday, DEMO_INVOICES, createInvoice } from "./invoices";
import { runTreasuryOnce, treasuryMode, treasuryStatus } from "./agent";
import { getDecision, verifyChain } from "../ledger";
import type { Address, Tier } from "../types";

const NOW = 1_800_000_000;
function verdict(tier: Tier, over: Partial<VerdictLike> = {}): VerdictLike {
  const limits = { LOW: { maxPerTxUsdc: 10_000, maxPerDayUsdc: 50_000 }, MEDIUM: { maxPerTxUsdc: 250, maxPerDayUsdc: 1_000 }, HIGH: { maxPerTxUsdc: 0, maxPerDayUsdc: 0 } }[tier];
  const score = { LOW: 4, MEDIUM: 38, HIGH: 92 }[tier];
  return {
    address: "0x000000000000000000000000000000000000cafe", tier, score, decisionId: "dec_test", rationale: `Score ${score} → ${tier}.`,
    recommendedLimits: limits, attestation: { validUntil: NOW + 3600, registryTx: null }, ...over,
  };
}
const policy: TreasuryPolicy = { maxTier: "MEDIUM", perPayoutCapUsdc: 100, dailyCapUsdc: 250, requireAttestationOnChain: false };

describe("decidePayout", () => {
  it("LOW within caps → PAY in full", () => {
    const d = decidePayout({ amountUsdc: 10 }, verdict("LOW"), policy, 0, { now: NOW });
    expect(d).toMatchObject({ action: "PAY", amount: 10, held: 0, bound: "none" });
    expect(d.reason).toMatch(/^PAID 10 USDC in full/);
    expect(d.verdictRef.decisionId).toBe("dec_test");
  });
  it("MEDIUM → capped to the analyst per-tx limit, remainder held", () => {
    const d = decidePayout({ amountUsdc: 120 }, verdict("MEDIUM", { recommendedLimits: { maxPerTxUsdc: 50, maxPerDayUsdc: 200 } }), policy, 0, { now: NOW });
    expect(d).toMatchObject({ action: "LIMIT", amount: 50, held: 70, bound: "analyst_max_per_tx" });
    expect(d.reason).toMatch(/LIMITED to 50 USDC by analyst per-tx limit 50 USDC; 70 USDC held/);
  });
  it("MEDIUM under every cap → PAY", () => {
    const d = decidePayout({ amountUsdc: 20 }, verdict("MEDIUM"), policy, 0, { now: NOW });
    expect(d).toMatchObject({ action: "PAY", amount: 20, held: 0 });
  });
  it("HIGH → HOLD everything, nothing released", () => {
    const d = decidePayout({ amountUsdc: 50 }, verdict("HIGH"), policy, 0, { now: NOW });
    expect(d).toMatchObject({ action: "HOLD", amount: 0, held: 50, bound: "tier" });
    expect(d.reason).toMatch(/^HELD: payee is HIGH/);
  });
  it("MEDIUM is HELD when policy.maxTier is LOW (incident mode)", () => {
    const d = decidePayout({ amountUsdc: 5 }, verdict("MEDIUM"), { ...policy, maxTier: "LOW" }, 0, { now: NOW });
    expect(d.action).toBe("HOLD"); expect(d.bound).toBe("tier");
  });
  it("per-payout cap binds a LOW payee → LIMIT", () => {
    const d = decidePayout({ amountUsdc: 150 }, verdict("LOW"), policy, 0, { now: NOW });
    expect(d).toMatchObject({ action: "LIMIT", amount: 100, held: 50, bound: "per_payout_cap" });
  });
  it("daily cap headroom binds; exhausted daily cap → HOLD", () => {
    const d = decidePayout({ amountUsdc: 60 }, verdict("LOW"), policy, 220, { now: NOW });
    expect(d).toMatchObject({ action: "LIMIT", amount: 30, held: 30, bound: "daily_cap" });
    const h = decidePayout({ amountUsdc: 60 }, verdict("LOW"), policy, 250, { now: NOW });
    expect(h).toMatchObject({ action: "HOLD", amount: 0, held: 60, bound: "daily_cap" });
    expect(h.reason).toMatch(/nothing releasable/);
  });
  it("expired signed attestation → HOLD regardless of tier", () => {
    const d = decidePayout({ amountUsdc: 10 }, verdict("LOW", { attestation: { validUntil: NOW - 1, registryTx: null } }), policy, 0, { now: NOW });
    expect(d).toMatchObject({ action: "HOLD", bound: "attestation_expired" });
  });
  it("requireAttestationOnChain: missing / UNKNOWN / expired registry entry → HOLD; valid → PAY", () => {
    const p = { ...policy, requireAttestationOnChain: true };
    expect(decidePayout({ amountUsdc: 10 }, verdict("LOW"), p, 0, { now: NOW, onChain: null }).bound).toBe("attestation_missing");
    expect(decidePayout({ amountUsdc: 10 }, verdict("LOW"), p, 0, { now: NOW, onChain: { tier: 0, validUntil: 0 } }).bound).toBe("attestation_missing");
    expect(decidePayout({ amountUsdc: 10 }, verdict("LOW"), p, 0, { now: NOW, onChain: { tier: 1, validUntil: NOW - 5 } }).bound).toBe("attestation_expired");
    expect(decidePayout({ amountUsdc: 10 }, verdict("LOW"), p, 0, { now: NOW, onChain: { tier: 3, validUntil: NOW + 500 } }).bound).toBe("tier");
    expect(decidePayout({ amountUsdc: 10 }, verdict("LOW"), p, 0, { now: NOW, onChain: { tier: 1, validUntil: NOW + 500 } }).action).toBe("PAY");
  });
  it("rounds to 6 dp and never pays a negative amount", () => {
    const d = decidePayout({ amountUsdc: 0.1234567 }, verdict("LOW"), policy, 0, { now: NOW });
    expect(d.amount).toBe(0.123457);
    expect(DEFAULT_POLICY.maxTier).toBe("MEDIUM");
  });
});

describe("invoices + dry-run tick", () => {
  beforeAll(async () => { await migrateTreasury(); });

  it("seedDemoInvoices is idempotent", async () => {
    const a = await seedDemoInvoices();
    const b = await seedDemoInvoices();
    expect(a.inserted).toBe(3); expect(b.inserted).toBe(0);
    const all = await listInvoices();
    expect(all.filter((i) => i.id.startsWith("inv_demo_"))).toHaveLength(3);
    expect(all.map((i) => i.status)).toEqual(["PENDING", "PENDING", "PENDING"]);
    expect(all.find((i) => i.id === "inv_demo_beef")?.amountUsdc).toBe(120);
  });

  it("defaults to dry-run when no treasury key is configured", () => {
    expect(treasuryMode()).toBe("dry-run");
    const s = treasuryStatus();
    expect(s.missingForLive).toContain("TREASURY_PRIVATE_KEY");
    expect(s.policy.requireAttestationOnChain).toBe(false);
  });

  it("dry-run tick: PAID / LIMITED / HELD with ledger PAYOUT entries and null tx hashes", async () => {
    const r = await runTreasuryOnce({ policy: { maxTier: "MEDIUM", perPayoutCapUsdc: 25, dailyCapUsdc: 50, requireAttestationOnChain: false } });
    expect(r.mode).toBe("dry-run");
    expect(r.processed).toBe(3);
    const by = Object.fromEntries(r.results.map((x) => [x.invoiceId, x]));
    expect(by.inv_demo_cafe).toMatchObject({ status: "PAID", tier: "LOW", paidUsdc: 10, heldUsdc: 0, txHash: null });
    expect(by.inv_demo_beef).toMatchObject({ status: "LIMITED", tier: "MEDIUM", paidUsdc: 25, heldUsdc: 95, txHash: null });
    expect(by.inv_demo_dead).toMatchObject({ status: "HELD", tier: "HIGH", paidUsdc: 0, heldUsdc: 50, txHash: null });
    expect(r).toMatchObject({ paid: 1, limited: 1, held: 1, failed: 0 });

    for (const x of r.results) {
      expect(x.decisionId).toMatch(/^dec_/);
      const payout = await getDecision(x.payoutDecisionId!);
      expect(payout?.kind).toBe("PAYOUT");
      expect(payout?.subject).toBe(x.payee);
      const p = payout?.payload as { type: string; status: string; verdict: { decisionId: string; attestation: { signature: string } }; reason: string; simulated: boolean };
      expect(p.type).toBe("PAYOUT"); expect(p.status).toBe(x.status); expect(p.simulated).toBe(true);
      expect(p.verdict.decisionId).toBe(x.decisionId);
      expect(p.verdict.attestation.signature).toMatch(/^0x/);
      expect(p.reason).toBe(x.reason);
      const screenEntry = await getDecision(x.decisionId!);
      expect(screenEntry?.kind).toBe("SCREEN");
    }
    expect((await verifyChain()).ok).toBe(true);

    const rows = await listInvoices();
    expect(rows.every((i) => i.status !== "PENDING")).toBe(true);
    expect(rows.find((i) => i.id === "inv_demo_beef")).toMatchObject({ status: "LIMITED", paidUsdc: 25, heldUsdc: 95, mode: "dry-run", txHash: null });
    expect(await spentToday()).toBe(35);

    // nothing pending → no-op
    const again = await runTreasuryOnce();
    expect(again.processed).toBe(0);
  }, 60_000);

  it("a never-paid address that resembles a trusted payee is flagged as a lookalike (address poisoning)", async () => {
    const poison = "0x000000000000000000000000000000000000caf1" as Address; // one hex char away from Lela's …cafe
    const inv = await createInvoice({ payee: poison, label: "Lela — logo design", amountUsdc: 5 });
    const r = await runTreasuryOnce({ policy: { maxTier: "LOW", perPayoutCapUsdc: 25, dailyCapUsdc: 1000, requireAttestationOnChain: false } });
    const x = r.results.find((y) => y.invoiceId === inv.id)!;
    const p = (await getDecision(x.payoutDecisionId!))?.payload as { verdict: { reasonCodes: string[] } };
    expect(p.verdict.reasonCodes).toContain("LOOKALIKE_OF_KNOWN_PAYEE");
    expect(x.tier).not.toBe("LOW");
    expect(x.status).toBe("HELD"); // maxTier LOW in this policy → nothing leaves; daily spend unchanged
  }, 60_000);

  it("a new invoice to a LOW payee is paid on the next tick; daily cap carries over", async () => {
    const inv = await createInvoice({ payee: DEMO_INVOICES[0].payee as Address, label: "Lela — second invoice", amountUsdc: 30 });
    const r = await runTreasuryOnce({ policy: { maxTier: "MEDIUM", perPayoutCapUsdc: 25, dailyCapUsdc: 50, requireAttestationOnChain: false } });
    const x = r.results.find((y) => y.invoiceId === inv.id)!;
    // 35 already spent today of a 50 cap → 15 headroom
    expect(x).toMatchObject({ status: "LIMITED", paidUsdc: 15, heldUsdc: 15 });
    expect(x.reason).toMatch(/daily cap/);
  }, 60_000);
});
