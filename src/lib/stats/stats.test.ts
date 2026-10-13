import "../__tests__/setup";
process.env.ATTESTER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
process.env.OWN_WALLETS = "0x00000000000000000000000000000000000000aa";

import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize, hashCanonical } from "../attest/canonical";
import { __resetConfig } from "../config";
import { appendDecision } from "../ledger";
import { __resetDb, db } from "../store/db";
import { recordScreening } from "../store/repo";
import { __resetTrustmapMigration, addInflow, insertEdges, insertTierChange, migrateTrustmap, upsertCandidates, upsertNode, setLastTick, setCursor } from "../trustmap/store";
import type { Verdict } from "../types";
import { CSV_COLUMNS, __resetStats, computeDailyStats, getDailyStats, latestDailyStats, listDailyStats, periodFor, publishDailyStats, statsCsv, headline } from "./index";

const DATE = "2026-10-12";
const { from, to } = periodFor(DATE);
const inDay = from + 3600;
const A = "0x1111111111111111111111111111111111111111" as const;
const B = "0x2222222222222222222222222222222222222222" as const;
const C = "0x3333333333333333333333333333333333333333" as const;
const BAD = "0x098b716b8aaf21512996dc57eb0615e2383e2f96" as const; // HIGH + sanctioned

function verdict(tier: Verdict["tier"], subject: string, codes: string[] = []): Verdict {
  return {
    address: subject as `0x${string}`, score: tier === "HIGH" ? 90 : tier === "MEDIUM" ? 40 : 5, tier, recommendedLimits: { maxPerTxUsdc: 1, maxPerDayUsdc: 2 },
    reasons: codes.map((code) => ({ code: code as Verdict["reasons"][number]["code"], weight: 1, evidence: {} })), rationale: "", eddRequested: [],
    nextRescreenAt: "", decisionId: "dec_x", screenedAt: "", evidence: {} as Verdict["evidence"],
    attestation: { typedData: { domain: { name: "CompliR", version: "1", chainId: 5042, verifyingContract: "0x" }, types: { Attestation: [] }, primaryType: "Attestation", message: { subject: subject as `0x${string}`, tier: 1, score: 1, decisionHash: "0x", issuedAt: inDay, validUntil: inDay + 10 } }, signature: "0x", attester: "0x", validUntil: inDay + 10, registryTx: null },
  };
}

async function seed() {
  const d = db();
  await migrateTrustmap();
  await recordScreening(verdict("LOW", A, ["CLEAN"]), "acme", "outside");
  await recordScreening(verdict("MEDIUM", A, ["FRESH_WALLET"]), "acme", "outside"); // A ends MEDIUM
  await recordScreening(verdict("HIGH", BAD, ["SANCTIONS_DIRECT", "FRESH_WALLET"]), "web-explorer", "own");
  await recordScreening(verdict("LOW", B, ["CLEAN"]), "trustmap", "own");
  await d.execute({ sql: `UPDATE screenings SET created_at = ?`, args: [inDay] });
  await recordScreening(verdict("LOW", C, ["CLEAN"]), "acme", "outside"); // now → outside the period
  await upsertNode({ address: BAD, tier: "HIGH", score: 95, lastSeenBlock: 10, usdcIn24h: 0, reasonCodes: ["SANCTIONS_DIRECT"], rationale: null, decisionId: null, at: inDay });
  await upsertNode({ address: A, tier: "MEDIUM", score: 40, lastSeenBlock: 10, usdcIn24h: 0, reasonCodes: ["FRESH_WALLET"], rationale: null, decisionId: null, at: inDay });
  await upsertNode({ address: B, tier: "LOW", score: 5, lastSeenBlock: 10, usdcIn24h: 0, reasonCodes: [], rationale: null, decisionId: null, at: from - 100 });
  await upsertCandidates([{ address: C, usdcIn: 1, usdcOut: 0, txCount: 1, firstSeenBlock: 9, lastSeenBlock: 10, isContract: null }], inDay);
  const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
  await insertEdges([
    { from: A, to: B, usdc: 100, txHash: tx(1), block: 10 },
    { from: B, to: BAD, usdc: 25, txHash: tx(2), block: 11 },
    { from: C, to: A, usdc: 75, txHash: tx(3), block: 11 },
  ], inDay + 60);
  await insertEdges([{ from: A, to: B, usdc: 999, txHash: tx(4), block: 12 }], to + 5); // next day
  await addInflow(B, 10, 100, inDay + 60);
  await addInflow(A, 11, 75, inDay + 600);
  await insertTierChange({ address: A, from: "LOW", to: "MEDIUM", score: 40, block: 10, decisionId: null, at: inDay });
  await insertTierChange({ address: B, from: "MEDIUM", to: "LOW", score: 5, block: 10, decisionId: null, at: to + 1 }); // next day
  await appendDecision({ kind: "TIER_CHANGE", subject: A, clientId: "watcher", payload: { from: "MEDIUM", to: "HIGH", decisionId: "dec_tc" } });
  await d.execute({ sql: `UPDATE decisions SET created_at = ? WHERE kind = 'TIER_CHANGE'`, args: [inDay + 5] });
  await setCursor(12);
  await setLastTick({ at: inDay + 600, fromBlock: 10, toBlock: 12, blocksScanned: 3, logs: 3, recipients: 3, candidates: 1, graded: 2, failed: 0, rpcCalls: 5, partial: false, rateLimited: false });
  await d.execute({ sql: `INSERT INTO payments (tx_hash, payer, amount_usdc, endpoint, refunded, created_at) VALUES (?,?,?,?,0,?)`, args: [tx(9), "0x857b06519e91e3a54538791bdbb0e22373e36b66", 0.01, "/api/v1/screen", inDay] });
  await d.execute({ sql: `INSERT INTO payments (tx_hash, payer, amount_usdc, endpoint, refunded, created_at) VALUES (?,?,?,?,0,?)`, args: [tx(10), "0x00000000000000000000000000000000000000aa", 0.01, "/api/v1/screen", inDay] });
}

beforeEach(() => {
  __resetDb(); __resetStats(); __resetConfig(); __resetTrustmapMigration();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("computeDailyStats", () => {
  it("empty database → all zeros, tolerated missing tables, caveats present", async () => {
    const s = await computeDailyStats(DATE, { now: to + 1 });
    expect(s.graded).toEqual({ addresses: 0, screenings: 0, byTier: { LOW: 0, MEDIUM: 0, HIGH: 0 }, share: { LOW: 0, MEDIUM: 0, HIGH: 0 } });
    expect(s.volume).toEqual({ usdc: 0, edges: 0, flaggedUsdc: 0, flaggedShare: 0, flaggedEdges: 0, flaggedWalletsNow: 0 });
    expect(s.observed).toEqual({ wallets: 0, candidatesNow: 0, nodesNow: 0 });
    expect(s.tierChanges).toEqual({ total: 0, map: 0, watch: 0, up: 0, down: 0 });
    expect(s.reasons).toEqual([]);
    expect(s.bridged).toEqual({ available: false, table: null, transfers: 0, usdc: 0, flaggedUsdc: 0, flaggedShare: 0 });
    expect(s.tailer).toEqual({ ticks: 0, lastTickAt: null, cursorBlock: null, blocksScanned: null });
    expect(s.period.final).toBe(true);
    expect(s.caveats.join(" ")).toMatch(/not all of Arc/);
    expect(s.caveats.join(" ")).toMatch(/No CCTP inbound table/);
    expect(headline(s)).toMatch(/No USDC transfers observed/);
    await expect(computeDailyStats("2026-13-40")).rejects.toThrow(/date/);
  });

  it("populated database → per-day aggregates with flagged share, reason codes, client classes, ticks", async () => {
    await seed();
    const s = await computeDailyStats(DATE, { now: to + 1 });
    // A (last tier MEDIUM), BAD (HIGH), B (LOW); C is outside the period
    expect(s.graded).toEqual({ addresses: 3, screenings: 4, byTier: { LOW: 1, MEDIUM: 1, HIGH: 1 }, share: { LOW: 0.3333, MEDIUM: 0.3333, HIGH: 0.3333 } });
    expect(s.reasons).toEqual([
      { code: "CLEAN", count: 2, share: 0.5 }, { code: "FRESH_WALLET", count: 2, share: 0.5 }, { code: "SANCTIONS_DIRECT", count: 1, share: 0.25 },
    ]);
    expect(s.clients).toEqual({ outside: 2, internal: 2, unknown: 0, distinctClientIds: 3, outsidePayers: 1 });
    // edges in the day: 100 + 25 + 75 = 200; the 25 touches BAD (HIGH + sanctioned)
    expect(s.volume).toEqual({ usdc: 200, edges: 3, flaggedUsdc: 25, flaggedShare: 0.125, flaggedEdges: 1, flaggedWalletsNow: 1 });
    expect(headline(s)).toBe("12.5% of observed USDC volume touched a flagged wallet on 2026-10-12 (25 of 200 USDC across 3 transfers).");
    // observed: candidate C + nodes graded that day (A, BAD) + edge endpoints (A, B, BAD, C)
    expect(s.observed).toEqual({ wallets: 4, candidatesNow: 1, nodesNow: 3 });
    expect(s.tierChanges).toEqual({ total: 2, map: 1, watch: 1, up: 2, down: 0 });
    expect(s.tailer).toEqual({ ticks: 2, lastTickAt: new Date((inDay + 600) * 1000).toISOString(), cursorBlock: 12, blocksScanned: 3 });
    expect(s.side).toMatchObject({ paidCalls: 1, usdcPaid: 0.01 });
    expect(s.signer).toBe(privateKeyToAccount(process.env.ATTESTER_PRIVATE_KEY as `0x${string}`).address.toLowerCase());
  });

  it("flags a partial day and reads an optional cctp_inbound table when present", async () => {
    await seed();
    await db().execute(`CREATE TABLE cctp_inbound (id INTEGER PRIMARY KEY, recipient TEXT, amount_usdc TEXT, flagged INTEGER DEFAULT 0, created_at INTEGER)`);
    await db().execute({ sql: `INSERT INTO cctp_inbound (recipient, amount_usdc, flagged, created_at) VALUES (?,?,0,?), (?,?,0,?), (?,?,1,?)`, args: [BAD, "40", inDay, A, "50", inDay, A, "10", inDay] });
    const s = await computeDailyStats(DATE, { now: inDay + 100 });
    expect(s.period.final).toBe(false);
    expect(s.caveats.join(" ")).toMatch(/before the UTC day ended/);
    expect(s.bridged).toEqual({ available: true, table: "cctp_inbound", transfers: 3, usdc: 100, flaggedUsdc: 50, flaggedShare: 0.5 });
    expect(headline(s)).toMatch(/today/);
  });
});

describe("publishDailyStats", () => {
  it("signs with the attester (EIP-191 over keccak(canonical json)); verifiable; partial days recompute, final days stick", async () => {
    await seed();
    const a = await publishDailyStats(DATE, { now: inDay + 100 });
    expect(a.created).toBe(true);
    expect(a.stats.period.final).toBe(false);
    expect(a.hash).toBe(hashCanonical(canonicalize(a.stats)));
    const signer = privateKeyToAccount(process.env.ATTESTER_PRIVATE_KEY as `0x${string}`).address;
    expect(await verifyMessage({ address: signer, message: a.hash, signature: a.signature })).toBe(true);
    expect(await verifyMessage({ address: signer, message: a.hash.replace(/.$/, "0"), signature: a.signature })).toBe(false);
    const stored = (await getDailyStats(DATE))!;
    expect(hashCanonical(canonicalize(stored.stats))).toBe(a.hash);
    // partial → recomputed (now final)
    const b = await publishDailyStats(DATE, { now: to + 1 });
    expect(b.created).toBe(true); expect(b.stats.period.final).toBe(true); expect(b.hash).not.toBe(a.hash);
    // final → stored copy returned
    const c = await publishDailyStats(DATE, { now: to + 2 });
    expect(c.created).toBe(false); expect(c.hash).toBe(b.hash);
    const d = await publishDailyStats(DATE, { now: to + 3, force: true });
    expect(d.created).toBe(true);
    await publishDailyStats("2026-10-11", { now: to + 1 });
    expect((await latestDailyStats())!.date).toBe(DATE);
    expect((await listDailyStats(30)).map((x) => x.date)).toEqual([DATE, "2026-10-11"]);
    expect((await listDailyStats(30, { to: "2026-10-11" })).map((x) => x.date)).toEqual(["2026-10-11"]);
  });
});

describe("csv", () => {
  it("is flat, one row per day, header matches CSV_COLUMNS, quotes only when needed", async () => {
    await seed();
    await publishDailyStats(DATE, { now: to + 1 });
    await publishDailyStats("2026-10-11", { now: to + 1 });
    const csv = statsCsv(await listDailyStats(30));
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    const cells = lines[1].split(",");
    expect(cells).toHaveLength(CSV_COLUMNS.length);
    const col = (name: (typeof CSV_COLUMNS)[number]) => cells[CSV_COLUMNS.indexOf(name)];
    expect(col("date")).toBe(DATE); expect(col("final")).toBe("1");
    expect(col("graded_addresses")).toBe("3"); expect(col("volume_usdc")).toBe("200"); expect(col("flagged_share")).toBe("0.125");
    expect(col("top_reasons")).toBe("CLEAN:2;FRESH_WALLET:2;SANCTIONS_DIRECT:1");
    expect(col("bridged_available")).toBe("0");
    expect(col("hash")).toMatch(/^0x[0-9a-f]{64}$/); expect(col("signature")).toMatch(/^0x[0-9a-f]{130}$/);
    expect(lines[2].split(",")[0]).toBe("2026-10-11");
    expect(csv).not.toContain("\"");
  });
});
