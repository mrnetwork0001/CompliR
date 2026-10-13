import "../__tests__/setup";
process.env.PRICE_SCREEN_USDC = "0.01";
process.env.PRICE_WATCH_USDC = "0.05";

import { describe, it, expect, beforeAll } from "vitest";
import { __resetPricing, currentPrice, priceState, setPrice, validatePriceChange, steppedPrice, MIN_CHANGE_INTERVAL_S } from "./pricing";

const NOW = 1_800_000_000;

describe("validatePriceChange (pure)", () => {
  it("bounds", () => {
    expect(validatePriceChange("screen", 0.005, 0.004, null, NOW).ok).toBe(false);
    expect(validatePriceChange("screen", 0.05, 0.06, null, NOW).ok).toBe(false);
    expect(validatePriceChange("watch", 0.02, 0.019, null, NOW).ok).toBe(false);
    expect(validatePriceChange("watch", 0.2, 0.21, null, NOW).ok).toBe(false);
    expect(validatePriceChange("screen", 0.01, 0, null, NOW).reason).toMatch(/positive/);
  });
  it("step ≤ 20%", () => {
    expect(validatePriceChange("screen", 0.01, 0.012, null, NOW).ok).toBe(true);
    expect(validatePriceChange("screen", 0.01, 0.0121, null, NOW).ok).toBe(false);
    expect(validatePriceChange("screen", 0.01, 0.008, null, NOW).ok).toBe(true);
    expect(validatePriceChange("screen", 0.01, 0.0079, null, NOW).reason).toMatch(/exceeds ±20%/);
  });
  it("cooldown 6 h", () => {
    expect(validatePriceChange("screen", 0.01, 0.011, NOW - MIN_CHANGE_INTERVAL_S + 1, NOW).reason).toMatch(/cooldown/);
    expect(validatePriceChange("screen", 0.01, 0.011, NOW - MIN_CHANGE_INTERVAL_S, NOW).ok).toBe(true);
  });
  it("no-op change is refused", () => {
    expect(validatePriceChange("screen", 0.01, 0.01, null, NOW).reason).toMatch(/no change/);
  });
  it("steppedPrice clamps to bounds and returns null at the edge", () => {
    expect(steppedPrice("screen", 0.048, "up")).toBe(0.05);
    expect(steppedPrice("screen", 0.05, "up")).toBeNull();
    expect(steppedPrice("watch", 0.02, "down")).toBeNull();
    expect(steppedPrice("watch", 0.05, "down", 0.5)).toBe(0.04); // 50% asked, 20% applied
  });
});

describe("setPrice / currentPrice (in-memory DB)", () => {
  beforeAll(() => __resetPricing());
  it("falls back to the config price until the operator changes it", async () => {
    expect(await currentPrice("screen")).toBe(0.01);
    expect(await currentPrice("watch")).toBe(0.05);
    expect((await priceState("screen")).source).toBe("config");
  });
  it("applies a guarded change and the routes see it on the next read", async () => {
    const r = await setPrice("screen", 0.011, "demand up", { now: NOW });
    expect(r).toMatchObject({ ok: true, from: 0.01, to: 0.011, changedAt: NOW });
    expect(await currentPrice("screen")).toBe(0.011);
    const st = await priceState("screen", { fresh: true });
    expect(st).toMatchObject({ source: "operator", reason: "demand up", changedAt: NOW });
  });
  it("refuses a second change inside the cooldown and an out-of-step change after it", async () => {
    const tooSoon = await setPrice("screen", 0.012, "again", { now: NOW + 3600 });
    expect(tooSoon.ok).toBe(false); expect(tooSoon.reason).toMatch(/cooldown/);
    expect(await currentPrice("screen")).toBe(0.011);
    const tooBig = await setPrice("screen", 0.02, "jump", { now: NOW + MIN_CHANGE_INTERVAL_S });
    expect(tooBig.ok).toBe(false); expect(tooBig.reason).toMatch(/exceeds/);
    const ok = await setPrice("screen", 0.0132, "jump", { now: NOW + MIN_CHANGE_INTERVAL_S });
    expect(ok.ok).toBe(true);
    expect(await currentPrice("screen")).toBe(0.0132);
  });
  it("watch is independent", async () => {
    expect(await currentPrice("watch")).toBe(0.05);
    expect((await setPrice("watch", 0.3, "x", { now: NOW })).reason).toMatch(/outside bounds/);
  });
});
