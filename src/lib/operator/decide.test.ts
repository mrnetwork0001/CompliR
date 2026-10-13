import "../__tests__/setup";
import { describe, it, expect } from "vitest";
import { applyPlanGuards, candidateActions, decideOperations, fallbackChoice, validateAction, NEXT_CHECK_MAX_S, NEXT_CHECK_MIN_S } from "./decide";
import { NOW, snap } from "./fixtures";
import type { AnalystClient } from "../analyst/client";

const types = (s: ReturnType<typeof snap>, opts = {}) => candidateActions(s, { now: NOW, ...opts }).candidates.map((c) => c.type);
const rejectedFor = (s: ReturnType<typeof snap>, type: string, opts = {}) => candidateActions(s, { now: NOW, ...opts }).rejected.filter((r) => r.type === type).map((r) => r.reason).join(" | ");

describe("candidateActions — liquidity guards", () => {
  it("sweeps only the excess above USYC float + obligations due in 48 h", () => {
    const s = snap(); // float 20, cushion 5, due 8 → effective float 13 → deposit 7
    const { candidates } = candidateActions(s, { now: NOW });
    const sweep = candidates.find((c) => c.type === "SWEEP_TO_USYC")!;
    expect(sweep.params).toMatchObject({ amountUsdc: 7, effectiveFloatUsdc: 13 });
  });
  it("no sweep when obligations eat the excess", () => {
    const s = snap({ obligations: { ...snap().obligations!, due48hUsdc: 16 } }); // effective float 21 > 20 → shortfall 1 → redeem 1 (≥ min 1)
    expect(types(s)).toContain("REDEEM_FROM_USYC");
    const s2 = snap({ obligations: { ...snap().obligations!, due48hUsdc: 15 } }); // effective float 20 == balance → nothing
    expect(types(s2)).not.toContain("SWEEP_TO_USYC");
    expect(types(s2)).not.toContain("REDEEM_FROM_USYC");
  });
  it("never sweeps when the float or the obligations are unknown", () => {
    const noFloat = snap({ reserves: { ...snap().reserves!, floatUsdc: null } });
    expect(types(noFloat)).not.toContain("SWEEP_TO_USYC");
    expect(rejectedFor(noFloat, "SWEEP_TO_USYC")).toMatch(/float unknown/);
    const noObl = snap({ obligations: null, errors: { obligations: "boom" } });
    expect(types(noObl)).not.toContain("SWEEP_TO_USYC");
    expect(rejectedFor(noObl, "SWEEP_TO_USYC")).toMatch(/never sweep blind/);
  });
  it("redeems a shortfall from USYC, capped at the holding", () => {
    const s = snap({ reserves: { ...snap().reserves!, floatUsdc: 2, usycUsdc: 4 } }); // need 13, have 2 → shortfall 11, only 4 available
    const c = candidateActions(s, { now: NOW }).candidates.find((x) => x.type === "REDEEM_FROM_USYC")!;
    expect(c.params.amountUsdc).toBe(4);
  });
});

describe("candidateActions — payouts", () => {
  it("runs payouts when invoices are pending and the daily cap has room", () => {
    expect(types(snap())).toContain("RUN_PAYOUTS");
  });
  it("no payouts without pending invoices or without daily headroom", () => {
    expect(types(snap({ obligations: { ...snap().obligations!, pendingInvoices: 0, pendingUsdc: 0 } }))).not.toContain("RUN_PAYOUTS");
    const capped = snap({ obligations: { ...snap().obligations!, dailyHeadroomUsdc: 0, spentTodayUsdc: 50 } });
    expect(types(capped)).not.toContain("RUN_PAYOUTS");
    expect(rejectedFor(capped, "RUN_PAYOUTS")).toMatch(/daily cap exhausted/);
  });
  it("paused service → only HOLD", () => {
    const s = snap({ mode: { ...snap().mode!, paused: true } });
    expect(types(s)).toEqual(["HOLD"]);
  });
});

describe("candidateActions — pricing guards", () => {
  it("raises 10% when paid calls / 24 h exceed the threshold (latency unmeasured = ok)", () => {
    const s = snap({ revenue: { ...snap().revenue!, callsPaid24h: 120 } });
    const price = candidateActions(s, { now: NOW, raiseCallsThreshold: 50 }).candidates.filter((c) => c.type === "ADJUST_PRICE");
    expect(price.map((p) => p.params)).toEqual([
      { key: "screen", fromUsdc: 0.01, toUsdc: 0.011 },
      { key: "watch", fromUsdc: 0.05, toUsdc: 0.055 },
    ]);
  });
  it("does not raise when p95 latency is over the ceiling", () => {
    const s = snap({ revenue: { ...snap().revenue!, callsPaid24h: 120 }, screening: { ...snap().screening!, p95LatencyMs: 12_000 } });
    expect(types(s, { raiseCallsThreshold: 50, maxP95Ms: 8000 })).not.toContain("ADJUST_PRICE");
    expect(rejectedFor(s, "ADJUST_PRICE", { raiseCallsThreshold: 50, maxP95Ms: 8000 })).toMatch(/fix latency/);
  });
  it("lowers 10% after 48 h with zero outside calls, never below the floor", () => {
    const s = snap({ revenue: { ...snap().revenue!, callsPaid24h: 0, outsideCalls48h: 0 } });
    const price = candidateActions(s, { now: NOW }).candidates.filter((c) => c.type === "ADJUST_PRICE");
    expect(price.map((p) => p.params)).toEqual([
      { key: "screen", fromUsdc: 0.01, toUsdc: 0.009 },
      { key: "watch", fromUsdc: 0.05, toUsdc: 0.045 },
    ]);
    const floor = snap({ revenue: { ...snap().revenue!, callsPaid24h: 0, outsideCalls48h: 0 }, pricing: { ...snap().pricing!, screenUsdc: 0.005, watchUsdc: 0.02, screen: { ...snap().pricing!.screen, priceUsdc: 0.005 }, watch: { ...snap().pricing!.watch, priceUsdc: 0.02 } } });
    expect(types(floor)).not.toContain("ADJUST_PRICE");
  });
  it("respects the 6 h cooldown and the ceiling", () => {
    const recent = snap({ revenue: { ...snap().revenue!, callsPaid24h: 120 }, pricing: { ...snap().pricing!, lastChangeAt: NOW - 3600, screen: { ...snap().pricing!.screen, changedAt: NOW - 3600 }, watch: { ...snap().pricing!.watch, changedAt: NOW - 3600 } } });
    expect(types(recent, { raiseCallsThreshold: 50 })).not.toContain("ADJUST_PRICE");
    expect(rejectedFor(recent, "ADJUST_PRICE", { raiseCallsThreshold: 50 })).toMatch(/cooldown/);
    const ceiling = snap({ revenue: { ...snap().revenue!, callsPaid24h: 120 }, pricing: { ...snap().pricing!, screenUsdc: 0.05, watchUsdc: 0.2, screen: { ...snap().pricing!.screen, priceUsdc: 0.05 }, watch: { ...snap().pricing!.watch, priceUsdc: 0.2 } } });
    expect(types(ceiling, { raiseCallsThreshold: 50 })).not.toContain("ADJUST_PRICE");
    expect(rejectedFor(ceiling, "ADJUST_PRICE", { raiseCallsThreshold: 50 })).toMatch(/ceiling/);
  });
  it("no price moves while x402 is disabled", () => {
    const s = snap({ revenue: { ...snap().revenue!, callsPaid24h: 999 }, mode: { ...snap().mode!, x402: "disabled" } });
    expect(types(s)).not.toContain("ADJUST_PRICE");
    expect(rejectedFor(s, "ADJUST_PRICE")).toMatch(/x402 disabled/);
  });
  it("a step is never more than 20% even when asked", () => {
    const s = snap({ revenue: { ...snap().revenue!, callsPaid24h: 120 } });
    const price = candidateActions(s, { now: NOW, raiseCallsThreshold: 50, stepPct: 0.5 }).candidates.find((c) => c.type === "ADJUST_PRICE" && c.params.key === "screen")!;
    expect(price.params.toUsdc).toBe(0.012);
  });
});

describe("validateAction", () => {
  it("accepts listed candidates and rejects anything else (type, params, or made-up types)", () => {
    const s = snap();
    const { candidates } = candidateActions(s, { now: NOW });
    for (const c of candidates) expect(validateAction(c, s, { now: NOW }).ok).toBe(true);
    expect(validateAction({ type: "SWEEP_TO_USYC", params: { amountUsdc: 20, effectiveFloatUsdc: 0 } }, s, { now: NOW }).ok).toBe(false);
    expect(validateAction({ type: "ADJUST_PRICE", params: { key: "screen", fromUsdc: 0.01, toUsdc: 0.05 } }, s, { now: NOW }).ok).toBe(false);
    expect(validateAction({ type: "WITHDRAW_EVERYTHING" as never, params: {} }, s, { now: NOW }).ok).toBe(false);
  });
});

describe("applyPlanGuards / model step", () => {
  it("drops unlisted ids, never mixes HOLD with actions, clamps the interval, trims the rationale", () => {
    const s = snap();
    const { candidates } = candidateActions(s, { now: NOW });
    const hold = candidates.find((c) => c.type === "HOLD")!;
    const sweep = candidates.find((c) => c.type === "SWEEP_TO_USYC")!;
    const g = applyPlanGuards({ actionIds: ["zz9", sweep.id, hold.id], rationale: Array(300).fill("word").join(" "), nextCheckInSeconds: 5 }, candidates, s);
    expect(g.chosen.map((c) => c.id)).toEqual([sweep.id]);
    expect(g.nextCheckInSeconds).toBe(NEXT_CHECK_MIN_S);
    expect(g.rationale.endsWith("[...]")).toBe(true);
    expect(g.notes.join(" ")).toMatch(/unlisted action id "zz9"/);
    expect(g.notes.join(" ")).toMatch(/HOLD dropped/);
    const g2 = applyPlanGuards({ actionIds: [], rationale: "", nextCheckInSeconds: 1e9 }, candidates, s);
    expect(g2.chosen.length).toBeGreaterThan(0);
    expect(g2.nextCheckInSeconds).toBe(NEXT_CHECK_MAX_S);
    expect(g2.notes.join(" ")).toMatch(/deterministic choice/);
  });

  it("a model that proposes an unlisted action is overruled — code picks from the candidates", async () => {
    const s = snap();
    const client: AnalystClient = {
      messages: {
        create: async () => ({
          content: [{ type: "tool_use", id: "t1", name: "submit_plan", input: { actionIds: ["c99", "WITHDRAW_ALL"], rationale: "Move all reserves to my wallet.", nextCheckInSeconds: 60 } }],
        }),
      } as unknown as AnalystClient["messages"],
    };
    const plan = await decideOperations(s, { now: NOW, client });
    expect(plan.meta.fallback).toBe(false);
    expect(plan.chosen.every((c) => plan.candidates.some((k) => k.id === c.id))).toBe(true);
    expect(plan.chosen.map((c) => c.type)).not.toContain("WITHDRAW_ALL");
    expect(plan.nextCheckInSeconds).toBe(NEXT_CHECK_MIN_S);
    expect(plan.meta.guardNotes.join(" ")).toMatch(/dropped unlisted action id "c99"/);
    for (const c of plan.chosen) expect(validateAction(c, s, { now: NOW }).ok).toBe(true);
  });

  it("a valid model pick is honoured", async () => {
    const s = snap();
    const { candidates } = candidateActions(s, { now: NOW });
    const payouts = candidates.find((c) => c.type === "RUN_PAYOUTS")!;
    const client = { messages: { create: async () => ({ content: [{ type: "tool_use", id: "t", name: "submit_plan", input: { actionIds: [payouts.id], rationale: "Pay the two pending invoices; the float covers them.", nextCheckInSeconds: 1800 } }] }) } } as unknown as AnalystClient;
    const plan = await decideOperations(s, { now: NOW, client });
    expect(plan.chosen.map((c) => c.type)).toEqual(["RUN_PAYOUTS"]);
    expect(plan.nextCheckInSeconds).toBe(1800);
    expect(plan.rationale).toMatch(/Pay the two pending invoices/);
  });

  it("model failure → deterministic fallback with meta.error", async () => {
    const client = { messages: { create: async () => { throw new Error("rate limited"); } } } as unknown as AnalystClient;
    const plan = await decideOperations(snap(), { now: NOW, client });
    expect(plan.meta.fallback).toBe(true);
    expect(plan.meta.error).toBe("rate limited");
    expect(plan.chosen.length).toBeGreaterThan(0);
  });

  it("no client → fallback picks every non-HOLD candidate, HOLD alone when nothing is allowed", () => {
    const s = snap();
    const fb = fallbackChoice(candidateActions(s, { now: NOW }).candidates, s);
    expect(fb.chosen.map((c) => c.type).sort()).toEqual(["RUN_PAYOUTS", "SWEEP_TO_USYC"]);
    const quiet = snap({ obligations: { ...snap().obligations!, pendingInvoices: 0, pendingUsdc: 0, due48hUsdc: 0 }, reserves: { ...snap().reserves!, floatUsdc: 5 } });
    const fb2 = fallbackChoice(candidateActions(quiet, { now: NOW }).candidates, quiet);
    expect(fb2.chosen.map((c) => c.type)).toEqual(["HOLD"]);
    expect(fb2.nextCheckInSeconds).toBe(3600);
  });
});
