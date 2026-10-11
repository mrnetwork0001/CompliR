import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __resetOverridesCache, applyFactsOverride, fundersFromOverride, loadOverrides, parseOverrides } from "./overrides";
import { emptyFacts } from "./arcGraph";

const DEAD = "0x000000000000000000000000000000000000dead" as const;
const BEEF = "0x000000000000000000000000000000000000beef" as const;
const CAFE = "0x000000000000000000000000000000000000cafe" as const;
const BAD2 = "0x000000000000000000000000000000000000bad2" as const;

describe("overrides", () => {
  it("parses the shipped .data/overrides.json demo file", () => {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), ".data/overrides.json"), "utf8"));
    const o = parseOverrides(raw);
    expect(o[DEAD].sanctions?.[0].matchedOn).toBe("address");
    expect(o[DEAD].usdcBlacklisted).toBe(true);
    const beef = fundersFromOverride(o[BEEF])!;
    expect(beef.map((f) => f.hop)).toEqual([1, 2]);
    expect(beef[1].facts.address).toBe(BAD2);
    expect(beef[1].facts.sanctions).toHaveLength(1);
    expect(beef[1].facts.usdcBlacklisted).toBe(false); // partial facts filled with defaults
    expect(beef[1].path).toHaveLength(2);
    expect(o[CAFE].txCount).toBe(400);
    expect(fundersFromOverride(o[CAFE])).toEqual([]);
  });

  it("lowercases keys and merges only the fields present", () => {
    const o = parseOverrides({ "0x000000000000000000000000000000000000DEAD": { usdcBlacklisted: true, firstSeen: null } });
    const live = { ...emptyFacts(DEAD), firstSeen: 1, txCount: 7, sanctions: [] };
    const merged = applyFactsOverride(live, o[DEAD]);
    expect(merged).toEqual({ ...live, usdcBlacklisted: true, firstSeen: null });
    expect(applyFactsOverride(live, undefined)).toBe(live);
  });

  it("loadOverrides: env JSON wins, malformed input → {} and never throws, missing file → {}", () => {
    __resetOverridesCache();
    expect(loadOverrides({ json: JSON.stringify({ [CAFE]: { txCount: 1 } }) })[CAFE]).toEqual({ txCount: 1 });
    expect(loadOverrides({ json: "{not json" })).toEqual({});
    expect(loadOverrides({ json: JSON.stringify({ nope: {} }) })).toEqual({});
    expect(loadOverrides({ json: null, filePath: "/nonexistent/overrides.json" })).toEqual({});
    expect(loadOverrides({ json: null, filePath: null })).toEqual({});
    __resetOverridesCache();
  });

  it("rejects bad hop values and tx hashes", () => {
    expect(() => parseOverrides({ [BEEF]: { funders: [{ hop: 3, path: [], facts: { address: BAD2 } }] } })).toThrow();
    expect(() =>
      parseOverrides({ [BEEF]: { funders: [{ hop: 1, path: [{ from: BAD2, to: BEEF, txHash: "0x12", amountUsdc: "1", timestamp: 1 }], facts: { address: BAD2 } }] } }),
    ).toThrow();
  });
});
