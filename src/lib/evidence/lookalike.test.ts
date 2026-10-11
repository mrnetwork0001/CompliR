import { describe, expect, it } from "vitest";
import { detectPayeeChange, findLookalikes, levenshtein, levenshteinSimilarity, sharesAffixes } from "./lookalike";

const payee = "0x12ab000000000000000000000000000000009f3c" as const;
const poison = "0x12abffffffffffffffffffffffffffffffff9f3c" as const; // same first-4/last-4, different middle
const nearMiss = "0x12ab000000000000000000000000000000009f3d" as const; // 1 char off (lev ≥ 0.8)
const unrelated = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as const;

describe("lookalike", () => {
  it("levenshtein basics", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshteinSimilarity(payee, payee)).toBe(1);
  });

  it("flags an address-poisoning twin (same first-4 + last-4) at similarity 1.0", () => {
    expect(sharesAffixes(poison, payee)).toBe(true);
    const r = findLookalikes(poison, [{ label: "Lela", address: payee }]);
    expect(r).toEqual([{ payeeLabel: "Lela", payeeAddress: payee, similarity: 1 }]);
  });

  it("flags a near-identical address via Levenshtein ≥ 0.8", () => {
    const r = findLookalikes(nearMiss, [{ label: "Lela", address: payee }]);
    expect(r).toHaveLength(1);
    expect(r[0].similarity).toBeGreaterThanOrEqual(0.8);
    expect(r[0].similarity).toBeLessThan(1);
  });

  it("ignores the payee itself and unrelated addresses; is case-insensitive", () => {
    expect(findLookalikes(payee, [{ label: "Lela", address: payee }])).toEqual([]);
    expect(findLookalikes(unrelated, [{ label: "Lela", address: payee }])).toEqual([]);
    expect(findLookalikes(poison.toUpperCase().replace("0X", "0x") as `0x${string}`, [{ label: "Lela", address: payee }])).toHaveLength(1);
  });

  it("detectPayeeChange: same label, new address", () => {
    const prev = [{ label: "Acme Ltd", address: payee }];
    const cur = [{ label: "acme ltd ", address: unrelated }];
    expect(detectPayeeChange(unrelated, cur, prev)).toEqual({ payeeLabel: "acme ltd ", previousAddress: payee });
    expect(detectPayeeChange(payee, prev, prev)).toBeNull();
    expect(detectPayeeChange(unrelated, cur, undefined)).toBeNull();
  });
});
