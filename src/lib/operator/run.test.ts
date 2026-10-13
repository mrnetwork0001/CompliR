import "../__tests__/setup";
import { describe, it, expect, vi } from "vitest";

vi.mock("../treasury", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../treasury")>();
  return { ...mod, runTreasuryOnce: vi.fn(async () => ({ mode: "dry-run", processed: 2, paid: 1, limited: 0, held: 1, failed: 0, results: [] })) };
});
vi.mock("../usyc", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../usyc")>();
  return { ...mod, runSweepOnce: vi.fn(async () => ({ mode: "dry", executed: false, wallet: null, balances: null, plan: { action: "DEPOSIT", amount: 7, reason: "env float " + process.env.USYC_FLOAT_USDC }, txs: {}, decisionId: "dec_sweep" })) };
});

import { runTreasuryOnce } from "../treasury";
import { runSweepOnce } from "../usyc";
import { getDecision, listDecisions, verifyChain } from "../ledger";
import { runOperatorOnce } from "./run";
import { NOW, snap } from "./fixtures";
import type { AnalystClient } from "../analyst/client";

describe("runOperatorOnce", () => {
  it("snapshot → decide → execute → ONE OPERATOR ledger entry with the full record", async () => {
    const before = (await listDecisions({ limit: 5 })).filter((e) => e.kind === "OPERATOR").length;
    const t = await runOperatorOnce({ now: NOW, snapshotFn: async () => snap(), client: null });
    expect(t.entry.kind).toBe("OPERATOR");
    expect(t.entry.clientId).toBe("operator");
    expect(t.results.map((r) => r.action.type)).toEqual(["RUN_PAYOUTS", "SWEEP_TO_USYC"]); // execution order
    expect(t.results.every((r) => r.ok && r.revalidated.ok)).toBe(true);
    expect(runTreasuryOnce).toHaveBeenCalledTimes(1);
    expect(runSweepOnce).toHaveBeenCalledTimes(1);
    // the sweep ran with the operator's effective float (cushion 5 + 8 due) and the env was restored afterwards
    expect((t.results[1].result as { plan: { reason: string } }).plan.reason).toBe("env float 13");
    expect(process.env.USYC_FLOAT_USDC).toBeUndefined();

    const stored = await getDecision(t.entry.id);
    expect(stored?.kind).toBe("OPERATOR");
    const p = stored!.payload as { type: string; snapshot: { revenue: unknown; reserves: { circle: unknown } }; candidates: unknown[]; rejected: unknown[]; chosen: { type: string; ok: boolean }[]; rationale: string; nextCheckAt: number; meta: { fallback: boolean; model: string } };
    expect(p.type).toBe("OPERATOR");
    expect(p.snapshot.revenue).toBeTruthy();
    expect(p.candidates.length).toBeGreaterThanOrEqual(3);
    expect(p.chosen.map((c) => c.type)).toEqual(["RUN_PAYOUTS", "SWEEP_TO_USYC"]);
    expect(p.rationale.length).toBeGreaterThan(20);
    expect(p.nextCheckAt).toBe(NOW + t.plan.nextCheckInSeconds);
    expect(p.meta).toMatchObject({ fallback: true, model: "fallback" });
    const after = (await listDecisions({ limit: 50 })).filter((e) => e.kind === "OPERATOR").length;
    expect(after).toBe(before + 1);
    expect((await verifyChain()).ok).toBe(true);
  });

  it("model picks by id: every listed pick is re-validated against the guards and executed exactly once; HOLD is dropped when acting", async () => {
    vi.mocked(runTreasuryOnce).mockClear();
    const s = snap();
    const client = { messages: { create: async () => ({ content: [{ type: "tool_use", id: "t", name: "submit_plan", input: { actionIds: ["c1", "c2", "c3", "c4", "c5", "nope"], rationale: "Do everything.", nextCheckInSeconds: 900 } }] }) } } as unknown as AnalystClient;
    let calls = 0;
    const t = await runOperatorOnce({ now: NOW, client, snapshotFn: async () => s, executors: { payouts: async () => { calls++; return { processed: 0 }; } } });
    expect(t.results.map((r) => r.action.type)).toEqual(["RUN_PAYOUTS", "SWEEP_TO_USYC"]);
    for (const r of t.results) expect(r.revalidated.ok).toBe(true);
    expect(calls).toBe(1);
    const p = t.entry.payload as { chosen: { type: string; ok: boolean }[]; meta: { fallback: boolean; guardNotes: string[] } };
    expect(p.meta.fallback).toBe(false);
    expect(p.meta.guardNotes.join(" ")).toMatch(/dropped unlisted action id "nope"/);
    expect(p.meta.guardNotes.join(" ")).toMatch(/HOLD dropped/);
    expect(p.chosen.find((c) => c.type === "RUN_PAYOUTS")?.ok).toBe(true);
  });

  it("an executor that throws is recorded as a failed action, the ledger entry is still written", async () => {
    const t = await runOperatorOnce({ now: NOW, snapshotFn: async () => snap(), client: null, executors: { sweep: async () => { throw new Error("teller reverted"); } } });
    const sweep = t.results.find((r) => r.action.type === "SWEEP_TO_USYC")!;
    expect(sweep.ok).toBe(false);
    expect(sweep.error).toBe("teller reverted");
    const p = (await getDecision(t.entry.id))!.payload as { chosen: { type: string; ok: boolean; error: string | null }[] };
    expect(p.chosen.find((c) => c.type === "SWEEP_TO_USYC")).toMatchObject({ ok: false, error: "teller reverted" });
  });

  it("price changes go through setPrice's own guard (a refused change is a failed action)", async () => {
    const s = snap({ revenue: { ...snap().revenue!, callsPaid24h: 120 } });
    const t = await runOperatorOnce({ now: NOW, snapshotFn: async () => s, client: null, raiseCallsThreshold: 50, executors: { payouts: async () => ({}), sweep: async () => ({}) } });
    const prices = t.results.filter((r) => r.action.type === "ADJUST_PRICE");
    expect(prices.length).toBe(2);
    expect(prices.every((r) => r.ok)).toBe(true);
    // same stale snapshot again: the DB already holds the new price → setPrice refuses ("no change"); and a fresh snapshot
    // one minute later is inside the 6 h cooldown → refused too. Either way nothing moves twice.
    const again = await runOperatorOnce({ now: NOW + 60, snapshotFn: async () => s, client: null, raiseCallsThreshold: 50, executors: { payouts: async () => ({}), sweep: async () => ({}) } });
    const p2 = again.results.filter((r) => r.action.type === "ADJUST_PRICE");
    expect(p2.length).toBe(2);
    expect(p2.every((r) => !r.ok && /no change|cooldown/.test(r.error ?? ""))).toBe(true);
    const fresh = snap({ revenue: { ...snap().revenue!, callsPaid24h: 120 }, pricing: { ...snap().pricing!, screenUsdc: 0.011, lastChangeAt: NOW, screen: { ...snap().pricing!.screen, priceUsdc: 0.011, changedAt: NOW }, watch: { ...snap().pricing!.watch, priceUsdc: 0.055, changedAt: NOW } } });
    const third = await runOperatorOnce({ now: NOW + 60, snapshotFn: async () => fresh, client: null, raiseCallsThreshold: 50, executors: { payouts: async () => ({}), sweep: async () => ({}) } });
    expect(third.plan.candidates.map((c) => c.type)).not.toContain("ADJUST_PRICE");
    expect(third.plan.rejected.filter((r) => r.type === "ADJUST_PRICE").every((r) => /cooldown/.test(r.reason))).toBe(true);
  });
});
