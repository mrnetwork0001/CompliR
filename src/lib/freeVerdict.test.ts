import "./__tests__/setup";
process.env.ATTESTER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetConfig } from "./config";
import { appendDecision } from "./ledger";
import { __resetDb } from "./store/db";
import { insertAttestation } from "./store/repo";
import { createEddRequest } from "./edd";
import { __resetFreeVerdict, freeVerdict, screenOnce } from "./freeVerdict";
import type { Reason, Verdict } from "./types";

const A = "0x098b716b8aaf21512996dc57eb0615e2383e2f96" as const;
const REASONS: Reason[] = [{ code: "SANCTIONS_DIRECT", weight: 100, evidence: { list: "OFAC SDN" } }];

function verdict(over: Partial<Verdict> & { issuedAt?: number; validUntil?: number } = {}): Verdict {
  const issuedAt = over.issuedAt ?? Math.floor(Date.now() / 1000);
  const validUntil = over.validUntil ?? issuedAt + 3600;
  return {
    address: A, score: 100, tier: "HIGH", recommendedLimits: { maxPerTxUsdc: 0, maxPerDayUsdc: 0 }, reasons: REASONS, rationale: "sanctioned",
    eddRequested: [], nextRescreenAt: new Date((issuedAt + 3600) * 1000).toISOString(), decisionId: over.decisionId ?? "dec_x", screenedAt: new Date(issuedAt * 1000).toISOString(),
    evidence: {} as Verdict["evidence"],
    attestation: { typedData: { domain: { name: "CompliR", version: "1", chainId: 5042, verifyingContract: "0x" }, types: { Attestation: [] }, primaryType: "Attestation", message: { subject: A, tier: 2, score: 100, decisionHash: "0x", issuedAt, validUntil } }, signature: "0x", attester: "0x", validUntil, registryTx: null },
    ...over,
  };
}

/** Seed a stored verdict the way the pipeline does: ledger entry (payload) + attestation row keyed by its id. */
async function seedStored(opts: { issuedAt?: number; validUntil?: number; tier?: Verdict["tier"]; edd?: string[] } = {}) {
  const v0 = verdict({ issuedAt: opts.issuedAt, validUntil: opts.validUntil, tier: opts.tier ?? "HIGH", eddRequested: opts.edd ?? [] });
  const entry = await appendDecision({ kind: "SCREEN", subject: A, clientId: null, payload: {
    address: A, score: v0.score, tier: v0.tier, reasons: v0.reasons, recommendedLimits: v0.recommendedLimits, rationale: v0.rationale,
    eddRequested: v0.eddRequested, nextRescreenAt: v0.attestation.typedData.message.issuedAt + 3600 } });
  const v = { ...v0, decisionId: entry.id };
  await insertAttestation(v);
  return v;
}

beforeEach(() => {
  __resetDb(); __resetConfig(); __resetFreeVerdict();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("freeVerdict", () => {
  it("returns reasons, recommendedLimits, rationale and nextRescreenAt for a stored verdict (same fields as paid)", async () => {
    const stored = await seedStored();
    const run = vi.fn();
    const out = await freeVerdict(A, { run });
    expect(out).toMatchObject({ source: "store", tier: "HIGH", decisionId: stored.decisionId, reasons: REASONS, recommendedLimits: { maxPerTxUsdc: 0, maxPerDayUsdc: 0 }, rationale: "sanctioned", expired: false, refreshing: false, edd: null });
    expect(out.nextRescreenAt).toBe(new Date((stored.attestation.typedData.message.issuedAt + 3600) * 1000).toISOString());
    expect(run).not.toHaveBeenCalled();
  });

  it("surfaces edd.url when an EDD request was opened for the decision", async () => {
    const stored = await seedStored({ tier: "MEDIUM", edd: ["Who funds this wallet?"] });
    const edd = await createEddRequest({ subject: A, decisionId: stored.decisionId, questions: ["Who funds this wallet?"] });
    const out = await freeVerdict(A, { run: vi.fn() });
    expect(out.edd).toEqual({ id: edd.id, url: edd.url, status: "OPEN" });
    expect(out.eddRequested).toEqual(["Who funds this wallet?"]);
  });

  it("screens a never-seen address on demand and returns the full verdict (source: fresh)", async () => {
    const run = vi.fn(async () => verdict({ decisionId: "dec_fresh" }));
    const out = await freeVerdict(A, { run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ source: "fresh", decisionId: "dec_fresh", reasons: REASONS, recommendedLimits: { maxPerTxUsdc: 0, maxPerDayUsdc: 0 }, expired: false, refreshing: false });
  });

  it("returns an expired verdict immediately and re-screens it in the background, once", async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedStored({ issuedAt: now - 7200, validUntil: now - 3600 });
    let release!: (v: Verdict) => void;
    const run = vi.fn(() => new Promise<Verdict>((r) => { release = r; }));
    const jobs: (() => Promise<unknown>)[] = [];
    const background = (fn: () => Promise<unknown>) => { jobs.push(fn); };
    const a = await freeVerdict(A, { run, background });
    expect(a).toMatchObject({ source: "store", expired: true, refreshing: true });
    expect(jobs).toHaveLength(1);
    const job = jobs[0]();
    const b = await freeVerdict(A, { run, background }); // second read while the re-screen is running
    expect(b).toMatchObject({ expired: true, refreshing: true });
    expect(jobs).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    release(verdict({ decisionId: "dec_new" }));
    await job;
  });

  it("concurrent first-sight requests share one pipeline run", async () => {
    let release!: (v: Verdict) => void;
    const run = vi.fn(() => new Promise<Verdict>((r) => { release = r; }));
    const p1 = screenOnce(A, run);
    const p2 = screenOnce(A.toUpperCase().replace("0X", "0x") as typeof A, run);
    release(verdict());
    const [v1, v2] = await Promise.all([p1, p2]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(v1).toBe(v2);
    screenOnce(A, run);
    expect(run).toHaveBeenCalledTimes(2); // cleared after completion
  });

  it("with maxWaitMs, returns status:screening when a first-sight screen is slower, and the screen keeps running", async () => {
    let release!: (v: Verdict) => void;
    const run = vi.fn(() => new Promise<Verdict>((r) => { release = r; }));
    const out = await freeVerdict(A, { run, maxWaitMs: 20 });
    expect(out).toMatchObject({ status: "screening", retryAfterSeconds: 5 });
    const again = await freeVerdict(A, { run, maxWaitMs: 20 });   // still running: shares the same screen
    expect(again).toMatchObject({ status: "screening" });
    expect(run).toHaveBeenCalledTimes(1);
    release(verdict());
  });

  it("with maxWaitMs, returns the verdict when the screen finishes in time", async () => {
    const run = vi.fn(async () => verdict({ decisionId: "dec_fast" }));
    const out = await freeVerdict(A, { run, maxWaitMs: 1000 });
    expect(out).toMatchObject({ source: "fresh", decisionId: "dec_fast" });
  });

  it("admitFirstSight runs only for a new first-sight screen and can refuse it", async () => {
    const admit = vi.fn(() => { throw new Error("limited"); });
    await expect(freeVerdict(A, { run: vi.fn(), admitFirstSight: admit })).rejects.toThrow("limited");
    expect(admit).toHaveBeenCalledTimes(1);
    await seedStored();
    const admit2 = vi.fn();
    await freeVerdict(A, { run: vi.fn(), admitFirstSight: admit2 });   // stored read: not counted
    expect(admit2).not.toHaveBeenCalled();
  });
});
