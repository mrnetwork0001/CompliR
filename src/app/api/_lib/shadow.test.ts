import { describe, expect, it } from "vitest";
import type { Verdict } from "@/lib/types";
import { tierForScore } from "@/lib/types";
import { ShadowRequestSchema, mapLimit, runShadow, uniqueTargets, SHADOW_MAX_ADDRESSES, SHADOW_CONCURRENCY } from "./shadow";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;

function fakeVerdict(address: `0x${string}`, score: number, codes: Verdict["reasons"][number]["code"][] = ["CLEAN"]): Verdict {
  const tier = tierForScore(score);
  const now = Math.floor(Date.now() / 1000);
  const zero = addr(0);
  return {
    address,
    score,
    tier,
    recommendedLimits: { maxPerTxUsdc: 0, maxPerDayUsdc: 0 },
    reasons: codes.map((code) => ({ code, weight: 0, evidence: {} })),
    rationale: "",
    eddRequested: [],
    nextRescreenAt: new Date().toISOString(),
    attestation: {
      typedData: {
        domain: { name: "CompliR", version: "1", chainId: 0, verifyingContract: zero },
        types: { Attestation: [] },
        primaryType: "Attestation",
        message: { subject: address, tier: 0, score, decisionHash: `0x${"0".repeat(64)}`, issuedAt: now, validUntil: now },
      },
      signature: "0x",
      attester: zero,
      validUntil: now,
      registryTx: null,
    },
    decisionId: `dec_${address.slice(-4)}`,
    screenedAt: new Date().toISOString(),
    evidence: {
      subject: { address, firstSeen: null, txCount: 0, usdcBlacklisted: false, protocolBlocklisted: false, sanctions: [] },
      funders: [], lookalikes: [], payeeChanged: null, concentration: null, priorTier: null, collectedAt: now, depth: 1,
    },
  };
}

describe("ShadowRequestSchema", () => {
  it("lowercases addresses and rejects bad tx hashes", () => {
    const ok = ShadowRequestSchema.safeParse({ payeeBook: [{ label: "A", address: addr(1).toUpperCase().replace("0X", "0x") }] });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.payeeBook[0].address).toBe(addr(1));
    const bad = ShadowRequestSchema.safeParse({ payeeBook: [{ label: "A", address: addr(1) }], recentPayments: [{ to: addr(1), amountUsdc: 1, txHash: "0x12" }] });
    expect(bad.success).toBe(false);
  });
  it("requires at least one payee", () => {
    expect(ShadowRequestSchema.safeParse({ payeeBook: [] }).success).toBe(false);
  });
});

describe("uniqueTargets", () => {
  it("dedupes, keeps book order, appends unlisted payment recipients, caps at max", () => {
    const req = ShadowRequestSchema.parse({
      payeeBook: [
        { label: "A", address: addr(1) },
        { label: "A again", address: addr(1) },
        { label: "B", address: addr(2) },
      ],
      recentPayments: [
        { to: addr(2), amountUsdc: 1 },
        { to: addr(3), amountUsdc: 2 },
      ],
    });
    const t = uniqueTargets(req);
    expect(t.map((x) => x.address)).toEqual([addr(1), addr(2), addr(3)]);
    expect(t[0].label).toBe("A");
    expect(t[2].label).toContain("unlisted");
    expect(uniqueTargets(req, 2)).toHaveLength(2);
  });
  it("never exceeds SHADOW_MAX_ADDRESSES", () => {
    const req = ShadowRequestSchema.parse({ payeeBook: Array.from({ length: 120 }, (_, i) => ({ label: `p${i}`, address: addr(i + 1) })) });
    expect(uniqueTargets(req)).toHaveLength(SHADOW_MAX_ADDRESSES);
  });
});

describe("mapLimit", () => {
  it("bounds concurrency and preserves order", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 11 }, (_, i) => i);
    const out = await mapLimit(items, SHADOW_CONCURRENCY, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 3 + (i % 3)));
      inFlight--;
      return i * 2;
    });
    expect(out).toEqual(items.map((i) => i * 2));
    expect(peak).toBeLessThanOrEqual(SHADOW_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });
  it("handles empty input", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});

describe("runShadow", () => {
  it("classifies holds/limits, counts lookalikes, and lists payments at risk", async () => {
    const req = ShadowRequestSchema.parse({
      payeeBook: [
        { label: "clean", address: addr(1) },
        { label: "shady", address: addr(2) },
        { label: "meh", address: addr(3) },
      ],
      recentPayments: [
        { to: addr(1), amountUsdc: 10 },
        { to: addr(2), amountUsdc: 20, txHash: `0x${"a".repeat(64)}` },
        { to: addr(3), amountUsdc: 30 },
        { to: addr(9), amountUsdc: 40 },
      ],
    });
    const scores: Record<string, number> = { [addr(1)]: 5, [addr(2)]: 90, [addr(3)]: 40, [addr(9)]: 50 };
    const seen: unknown[] = [];
    const r = await runShadow(req, async (q) => {
      seen.push(q);
      return fakeVerdict(q.address, scores[q.address], q.address === addr(3) ? ["LOOKALIKE_OF_KNOWN_PAYEE", "FRESH_WALLET"] : ["CLEAN"]);
    });
    expect(seen).toHaveLength(4);
    expect((seen[0] as { depth: number }).depth).toBe(1);
    expect((seen[0] as { payeeBook: unknown[] }).payeeBook).toHaveLength(3);
    expect(r.summary).toEqual({ screened: 4, wouldHold: 1, wouldLimit: 2, lookalikes: 1 });
    expect(r.entries.find((e) => e.label === "shady")).toMatchObject({ tier: "HIGH", wouldHold: true, wouldLimit: false });
    expect(r.entries.find((e) => e.label === "meh")).toMatchObject({ tier: "MEDIUM", wouldHold: false, wouldLimit: true, reasonCodes: ["LOOKALIKE_OF_KNOWN_PAYEE", "FRESH_WALLET"] });
    expect(r.paymentsAtRisk.map((p) => p.to)).toEqual([addr(2), addr(3), addr(9)]);
    expect(r.paymentsAtRisk[0].txHash).toBe(`0x${"a".repeat(64)}`);
    expect("txHash" in r.paymentsAtRisk[1]).toBe(false);
  });
});
