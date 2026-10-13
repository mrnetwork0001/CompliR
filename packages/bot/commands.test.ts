import { describe, expect, it } from "vitest";
import { parseCommand, formatVerdict, formatReport, formatError, usage, isAddress } from "./commands.mjs";

const A = "0x098b716B8Aaf21512996dC57EB0615e2383E2f96";
const a = A.toLowerCase();

describe("bot command parser", () => {
  it("parses slash commands with and without @bot suffix", () => {
    expect(parseCommand("/start")).toMatchObject({ cmd: "start" });
    expect(parseCommand("/help@complir_bot")).toMatchObject({ cmd: "start" });
    expect(parseCommand(`/check ${A}`)).toMatchObject({ cmd: "check", address: a });
    expect(parseCommand(`/check@complir_bot   ${A}`)).toMatchObject({ cmd: "check", address: a });
    expect(parseCommand(`/watch ${A}`)).toMatchObject({ cmd: "watch", address: a });
    expect(parseCommand("/report")).toMatchObject({ cmd: "report" });
    expect(parseCommand("/check")).toMatchObject({ cmd: "check", address: null });
    expect(parseCommand("/frobnicate")).toMatchObject({ cmd: "unknown" });
  });
  it("treats a pasted address as /check, but not a tx hash", () => {
    expect(parseCommand(`is ${A} safe?`)).toMatchObject({ cmd: "check", address: a });
    expect(parseCommand("0x" + "ab".repeat(32))).toMatchObject({ cmd: "text", address: null });
    expect(parseCommand("")).toMatchObject({ cmd: "empty" });
    expect(parseCommand("hello")).toMatchObject({ cmd: "text" });
  });
  it("isAddress", () => { expect(isAddress(a)).toBe(true); expect(isAddress("0x12")).toBe(false); });
});

describe("bot formatting", () => {
  it("formats a full verdict", () => {
    const t = formatVerdict({ address: a, tier: "HIGH", score: 95, reasons: [{ code: "SANCTIONS_DIRECT" }], rationale: "OFAC listed.", decisionId: "dec_1", recommendedLimits: { maxPerTxUsdc: 0, maxPerDayUsdc: 0 } }, "https://x.test");
    expect(t).toContain("[HIGH] HIGH · score 95/100");
    expect(t).toContain("Do not send");
    expect(t).toContain("Signals: SANCTIONS_DIRECT");
    expect(t).toContain("https://x.test/a/" + a);
    expect(t).toContain("https://x.test/log/dec_1");
  });
  it("formats a /api/v1/check-shaped response (headline, advice, limits)", () => {
    const t = formatVerdict({ address: a, tier: "HIGH", score: 100, headline: "Don't pay.", advice: "On the OFAC list.", limits: { maxPerTxUsdc: 0, maxPerDayUsdc: 0 }, decisionId: "dec_3" }, "https://x.test");
    expect(t).toContain("[HIGH] HIGH · score 100/100 · Don't pay.");
    expect(t).toContain("On the OFAC list.");
    expect(t).toContain("Limits: 0 USDC / tx · 0 USDC / day");
  });
  it("formats an attestation-shaped response with a note", () => {
    const t = formatVerdict({ address: a, tier: "LOW", score: 3, decisionId: "dec_2" }, "https://x.test", "(stored)");
    expect(t).toContain("[LOW] LOW");
    expect(t.endsWith("(stored)")).toBe(true);
  });
  it("formats report + errors + usage", () => {
    const r = formatReport({ date: "2026-10-14", hash: "0xabcdef0123456789abcdef", signer: "0xsig", report: { screenings: { total: 12, outside: 3, byTier: { LOW: 9, MEDIUM: 1, HIGH: 2 } }, totals: { outsidePayers: 2, paidCalls: 4, usdcIn: 0.04 }, watches: { created: 1, active: 5 }, tierChanges: { count: 1 } } }, "https://x.test");
    expect(r).toContain("2026-10-14"); expect(r).toContain("Screenings: 12 (3 from outside clients) · LOW 9 / MED 1 / HIGH 2"); expect(r).toContain("Watches: 5 active"); expect(r).toContain("https://x.test/report");
    expect(formatError({ status: 402 }, "b")).toMatch(/x402/);
    expect(formatError(new Error("boom"), "b")).toContain("boom");
    expect(usage("https://x.test")).toContain("/watch");
  });
});
