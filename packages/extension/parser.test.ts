import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const P = require("./lib/parser.js") as {
  findAddresses(t: string): { address: string; raw: string; index: number }[];
  uniqueAddresses(t: string[]): string[];
  isAddress(v: unknown): boolean;
  normalize(v: unknown): string | null;
  tierFromResponse(status: number, body: unknown): { tier: string; score: number | null; known: boolean };
  chipLabel(t: { tier: string; score: number | null }): string;
  chipTitle(t: { tier: string; score: number | null }, a: string): string;
  isFresh(e: unknown, now: number, ttl: number): boolean;
  chunk<T>(l: T[], n: number): T[][];
  CACHE_TTL_MS: number;
};

const LAZARUS = "0x098b716B8Aaf21512996dC57EB0615e2383E2f96";
const OURS = "0xc742ada2872a042dd36d2e706907b4036968960c";
const TX = "0x" + "ab".repeat(32);

describe("extension parser", () => {
  it("finds addresses in prose, lowercases, keeps raw + index", () => {
    const text = `Send to ${LAZARUS} today, not ${OURS}.`;
    const f = P.findAddresses(text);
    expect(f.map((x) => x.address)).toEqual([LAZARUS.toLowerCase(), OURS]);
    expect(f[0].raw).toBe(LAZARUS);
    expect(text.slice(f[0].index, f[0].index + 42)).toBe(LAZARUS);
  });
  it("ignores addresses embedded in longer hex (tx hashes) or identifiers", () => {
    expect(P.findAddresses(`tx ${TX}`)).toEqual([]);
    expect(P.findAddresses(`id_${OURS}`)).toEqual([]);
    expect(P.findAddresses(`${OURS}1`)).toEqual([]);
    expect(P.findAddresses(`(${OURS})`).length).toBe(1);
    expect(P.findAddresses(`${OURS}`).length).toBe(1);
  });
  it("dedupes across texts in first-seen order", () => {
    expect(P.uniqueAddresses([`${OURS} ${LAZARUS}`, LAZARUS.toUpperCase().replace("0X", "0x")])).toEqual([OURS, LAZARUS.toLowerCase()]);
  });
  it("validates and normalizes single values", () => {
    expect(P.isAddress(` ${OURS} `)).toBe(true);
    expect(P.isAddress(TX)).toBe(false);
    expect(P.normalize(LAZARUS)).toBe(LAZARUS.toLowerCase());
    expect(P.normalize("nope")).toBeNull();
  });
  it("maps attestation responses to chip models and labels", () => {
    const high = P.tierFromResponse(200, { tier: "HIGH", score: 95, decisionId: "dec_1" });
    expect(high).toMatchObject({ tier: "HIGH", score: 95, known: true });
    expect(P.chipLabel(high)).toBe("HIGH 95");
    expect(P.chipTitle(high, OURS)).toMatch(/HIGH risk \(score 95\/100\)/);
    const unknown = P.tierFromResponse(404, { error: { code: "NOT_FOUND" } });
    expect(unknown).toMatchObject({ tier: "UNKNOWN", known: false });
    expect(P.chipLabel(unknown)).toBe("?");
    expect(P.tierFromResponse(200, { tier: "BOGUS" }).tier).toBe("UNKNOWN");
  });
  it("cache freshness and chunking", () => {
    const now = 1_000_000;
    expect(P.isFresh({ at: now - 1000 }, now, P.CACHE_TTL_MS)).toBe(true);
    expect(P.isFresh({ at: now - P.CACHE_TTL_MS - 1 }, now, P.CACHE_TTL_MS)).toBe(false);
    expect(P.isFresh(undefined, now, P.CACHE_TTL_MS)).toBe(false);
    expect(P.chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
