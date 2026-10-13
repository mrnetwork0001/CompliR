import "../__tests__/setup";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Address, Verdict } from "../types";
import { aggregateRecipients, tailOnce, type ScreenFn, type TailClient } from "./tailer";
import { mapSnapshot, nodeHistory, recentTierChanges } from "./query";
import { getCursor, getNode, migrateTrustmap } from "./store";
import { seedDemo, DEMO_ADDRESSES } from "./seed";
import { layoutMap } from "./layout";

const EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";
const ZERO = "0x0000000000000000000000000000000000000000";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;

type L = { address: string; args: { from: Address; to: Address; value: bigint }; blockNumber: bigint; transactionHash: `0x${string}`; logIndex: number };
const log = (from: Address, to: Address, usdc: number, block: number, hash: number): L => ({
  address: EMITTER,
  args: { from, to, value: BigInt(Math.round(usdc * 1e6)) * 10n ** 12n },
  blockNumber: BigInt(block),
  transactionHash: tx(hash),
  logIndex: hash,
});

function mockClient(logs: L[], head: number, opts: { contracts?: Address[]; failLogs?: Error; failRangeOver?: number } = {}) {
  const contracts = new Set((opts.contracts ?? []).map((a) => a.toLowerCase()));
  const getLogs = vi.fn(async (args: { fromBlock: bigint; toBlock: bigint }) => {
    if (opts.failLogs) throw opts.failLogs;
    if (opts.failRangeOver && args.toBlock - args.fromBlock + 1n > BigInt(opts.failRangeOver)) throw new Error("query returned more than 2000 results");
    return logs.filter((l) => l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock);
  });
  const getCode = vi.fn(async ({ address }: { address: Address }) => (contracts.has(address.toLowerCase()) ? "0x6080" : undefined));
  const getBlockNumber = vi.fn(async () => BigInt(head));
  return { client: { getLogs, getCode, getBlockNumber } as unknown as TailClient, getLogs, getCode, getBlockNumber };
}

function verdict(address: Address, tier: Verdict["tier"], score: number, funders: { from: Address; to: Address; usdc: number }[] = []): Verdict {
  return {
    address, score, tier, recommendedLimits: { maxPerTxUsdc: 100, maxPerDayUsdc: 1000 },
    reasons: [{ code: tier === "LOW" ? "CLEAN" : "FRESH_WALLET", weight: score, evidence: {} }], rationale: `mock ${tier}`, eddRequested: [],
    nextRescreenAt: new Date().toISOString(),
    attestation: { typedData: {} as Verdict["attestation"]["typedData"], signature: "0x00", attester: addr(0xa77), validUntil: 0, registryTx: null },
    decisionId: `dec_${address.slice(-4)}_${score}`, screenedAt: new Date().toISOString(),
    evidence: {
      subject: { address, firstSeen: null, txCount: 0, usdcBlacklisted: false, protocolBlocklisted: false, sanctions: [] },
      funders: funders.map((f) => ({ hop: 1 as const, path: [{ from: f.from, to: f.to, txHash: tx(999), amountUsdc: f.usdc.toFixed(6), timestamp: 0 }], facts: { address: f.from, firstSeen: null, txCount: 0, usdcBlacklisted: false, protocolBlocklisted: false, sanctions: [] } })),
      lookalikes: [], payeeChanged: null, concentration: null, priorTier: null, collectedAt: 0, depth: 1,
    },
  };
}

const NOW = 1_800_000_000;
const common = { minUsdc: 25, regradeHours: 24, maxPerTick: 5, rpcBudget: 24, retryBaseMs: 1, seedDemo: false };

beforeAll(async () => {
  await migrateTrustmap();
});

describe("aggregateRecipients", () => {
  it("sums 18-dp values per recipient at 6 dp, drops self-sends and system addresses, keeps mints, sorts desc", () => {
    const A = addr(0xa1), B = addr(0xb2), S = addr(0x51);
    const logs = [log(S, A, 15, 1, 1), log(S, A, 15.5, 2, 2), log(S, B, 10, 2, 3), log(ZERO as Address, addr(0xd4), 50, 3, 4), log(A, A, 99, 3, 5), log(S, EMITTER as Address, 500, 3, 6)];
    const agg = aggregateRecipients(logs, 18);
    expect(agg.map((a) => [a.address, a.usdc, a.lastBlock, a.transfers])).toEqual([
      [addr(0xd4), 50, 3, 1],
      [A, 30.5, 2, 2],
      [B, 10, 2, 1],
    ]);
  });
});

describe("tailOnce", () => {
  it("grades EOAs above the threshold (biggest first), skips contracts, records edges among graded nodes, advances the cursor", async () => {
    const S = addr(0x1001), A = addr(0x1002), B = addr(0x1003), C = addr(0x1004), K = addr(0x1005);
    const logs = [log(S, A, 15, 101, 11), log(S, A, 15, 102, 12), log(S, B, 10, 102, 13), log(S, C, 100, 103, 14), log(S, K, 60, 103, 15), log(C, A, 5, 104, 16)];
    const { client, getCode, getLogs } = mockClient(logs, 110, { contracts: [K] });
    const screenFn = vi.fn<ScreenFn>(async (req) => verdict(req.address, req.address === C ? "HIGH" : "LOW", req.address === C ? 80 : 5));
    const r = await tailOnce({ ...common, client, screenFn, fromBlock: 100n, maxBlocks: 50, now: NOW });

    expect(r.blocksScanned).toBe(11); // 100..110 (head)
    expect(r.toBlock).toBe(110);
    expect(r.logs).toBe(6);
    expect(r.recipients).toBe(4);
    expect(r.candidates).toBe(3); // C 100, K 60, A 35 - B (10) is below 25
    expect(r.skippedContracts).toBe(1);
    expect(r.gradedNodes.map((g) => [g.address, g.tier])).toEqual([[C, "HIGH"], [A, "LOW"]]);
    expect(screenFn).toHaveBeenCalledTimes(2);
    expect(screenFn.mock.calls[0][1]).toMatchObject({ kind: "SCREEN", writeOnChain: false });
    expect(screenFn.mock.calls[0][0].clientId).toBe("trustmap");
    expect(getCode).toHaveBeenCalledTimes(3);
    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(r.rpcCalls).toBe(5); // 1 head + 1 getLogs + 3 getCode
    expect(r.rpcCalls).toBeLessThanOrEqual(24);
    expect(r.edges).toBe(1); // C → A, both graded
    expect(r.partial).toBe(false);
    expect(await getCursor()).toBe(110);

    const a = await getNode(A);
    expect(a?.usdcIn24h).toBeCloseTo(35);
    expect(a?.lastSeenBlock).toBe(104);
    expect(a?.prevTier).toBeNull();

    // contract result is cached: a second tick over the same window never asks getCode for K again
    getCode.mockClear();
    const r2 = await tailOnce({ ...common, client, screenFn, fromBlock: 100n, maxBlocks: 50, now: NOW + 60 });
    expect(r2.skippedRecent).toBe(2);
    expect(r2.skippedContracts).toBe(1);
    expect(getCode).not.toHaveBeenCalled();
    expect(screenFn).toHaveBeenCalledTimes(2);
  });

  it("respects the regrade window and records a tier change on regrade", async () => {
    const S = addr(0x2001), A = addr(0x2002);
    const logs = [log(S, A, 40, 201, 21)];
    const { client } = mockClient(logs, 205);
    let call = 0;
    const screenFn = vi.fn<ScreenFn>(async (req) => verdict(req.address, call++ === 0 ? "LOW" : "HIGH", call === 1 ? 3 : 90));

    const r1 = await tailOnce({ ...common, client, screenFn, fromBlock: 200n, maxBlocks: 10, now: NOW });
    expect(r1.graded).toBe(1);
    expect(r1.tierChanges).toBe(0);

    const r2 = await tailOnce({ ...common, client, screenFn, fromBlock: 200n, maxBlocks: 10, now: NOW + 3600 });
    expect(r2.graded).toBe(0);
    expect(r2.skippedRecent).toBe(1);
    expect(screenFn.mock.calls[0][1]).toMatchObject({ kind: "SCREEN" });

    const r3 = await tailOnce({ ...common, client, screenFn, fromBlock: 200n, maxBlocks: 10, now: NOW + 25 * 3600 });
    expect(r3.graded).toBe(1);
    expect(r3.tierChanges).toBe(1);
    expect(r3.gradedNodes[0]).toMatchObject({ address: A, tier: "HIGH", prevTier: "LOW", changed: true });
    expect(screenFn.mock.calls[1][1]).toMatchObject({ kind: "RESCREEN" });

    const n = await getNode(A);
    expect(n).toMatchObject({ tier: "HIGH", prevTier: "LOW", changedAt: NOW + 25 * 3600, score: 90 });
    const changes = await recentTierChanges(10);
    expect(changes[0]).toMatchObject({ address: A, from: "LOW", to: "HIGH", score: 90 });
    const h = await nodeHistory(A);
    expect(h?.changes).toHaveLength(1);
    expect(h?.node.reasonCodes).toEqual(["FRESH_WALLET"]);
  });

  it("backs off on rate limit: partial result, cursor untouched", async () => {
    const before = await getCursor();
    const { client } = mockClient([], 400, { failLogs: new Error("429 rate limit exceeded") });
    const screenFn = vi.fn();
    const r = await tailOnce({ ...common, client, screenFn, fromBlock: 390n, maxBlocks: 10, now: NOW });
    expect(r.partial).toBe(true);
    expect(r.rateLimited).toBe(true);
    expect(r.toBlock).toBeNull();
    expect(screenFn).not.toHaveBeenCalled();
    expect(await getCursor()).toBe(before);
    expect(r.rpcCalls).toBeLessThanOrEqual(24);
  });

  it("bisects a range that overflows the result cap and never exceeds the RPC budget", async () => {
    const S = addr(0x3001);
    const logs = Array.from({ length: 8 }, (_, i) => log(S, addr(0x3100 + i), 30, 500 + i, 300 + i));
    const { client, getLogs } = mockClient(logs, 507, { failRangeOver: 2 });
    const screenFn = vi.fn(async (req: { address: Address }) => verdict(req.address, "LOW", 1));
    const r = await tailOnce({ ...common, client, screenFn, fromBlock: 500n, maxBlocks: 8, now: NOW, maxPerTick: 2 });
    expect(getLogs.mock.calls.length).toBeGreaterThan(1);
    expect(r.logs).toBe(8);
    expect(r.graded).toBe(2);
    expect(r.rpcCalls).toBeLessThanOrEqual(24);
    expect(r.candidates).toBe(8);
  });

  it("also records edges from the verdict's funder paths when both ends are graded", async () => {
    const S = addr(0x4001), A = addr(0x4002), B = addr(0x4003);
    const logs = [log(S, A, 50, 601, 41), log(S, B, 50, 601, 42)];
    const { client } = mockClient(logs, 605);
    const screenFn = vi.fn(async (req: { address: Address }) => verdict(req.address, "MEDIUM", 40, req.address === A ? [{ from: B, to: A, usdc: 12 }] : []));
    const r = await tailOnce({ ...common, client, screenFn, fromBlock: 600n, maxBlocks: 10, now: NOW });
    expect(r.graded).toBe(2);
    expect(r.edges).toBe(1);
    const h = await nodeHistory(A);
    expect(h?.edges[0]).toMatchObject({ from: B, to: A, usdc: 12 });
  });
});

describe("mapSnapshot", () => {
  it("has the documented shape and only returns edges among returned nodes", async () => {
    const snap = await mapSnapshot({ limit: 150, now: NOW + 26 * 3600 });
    expect(Object.keys(snap.stats).sort()).toEqual(["cursorBlock", "graded", "high", "lastTick", "lastTickAt", "low", "medium", "tierChanges24h"].sort());
    expect(snap.stats.graded).toBe(snap.stats.high + snap.stats.medium + snap.stats.low);
    expect(snap.stats.graded).toBeGreaterThan(0);
    expect(snap.stats.tierChanges24h).toBe(1);
    expect(typeof snap.stats.cursorBlock).toBe("number");
    expect(snap.stats.lastTickAt).toMatch(/^\d{4}-/);
    for (const n of snap.nodes) {
      expect(n).toMatchObject({ address: expect.stringMatching(/^0x[0-9a-f]{40}$/), tier: expect.stringMatching(/^(LOW|MEDIUM|HIGH)$/) });
      expect(typeof n.score).toBe("number");
      expect(typeof n.usdcIn24h).toBe("number");
      expect(typeof n.lastSeenBlock).toBe("number");
      expect("changedAt" in n && "prevTier" in n).toBe(true);
    }
    const set = new Set(snap.nodes.map((n) => n.address));
    expect(snap.edges.length).toBeGreaterThan(0);
    for (const e of snap.edges) {
      expect(set.has(e.from) && set.has(e.to)).toBe(true);
      expect(e.txHash).toMatch(/^0x/);
    }
    // nodes are sorted by inflow desc
    for (let i = 1; i < snap.nodes.length; i++) expect(snap.nodes[i - 1].usdcIn24h).toBeGreaterThanOrEqual(snap.nodes[i].usdcIn24h);
  });

  it("seedDemo inserts the three demo addresses once and the layout places them in their tier clusters", async () => {
    const s1 = await seedDemo({ now: NOW, force: true });
    expect(s1.seeded).toBe(true);
    const s2 = await seedDemo({ now: NOW });
    expect(s2.seeded).toBe(false); // table not empty
    const snap = await mapSnapshot({ limit: 400, now: NOW });
    const demo = snap.nodes.filter((n) => n.source === "demo");
    expect(demo.map((d) => [d.address, d.tier]).sort()).toEqual([[DEMO_ADDRESSES.HIGH, "HIGH"], [DEMO_ADDRESSES.MEDIUM, "MEDIUM"], [DEMO_ADDRESSES.LOW, "LOW"]].sort());
    expect(snap.edges.some((e) => e.source === "demo")).toBe(true);
    expect((await nodeHistory(DEMO_ADDRESSES.MEDIUM))?.node.prevTier).toBe("LOW");

    const l1 = layoutMap(snap.nodes, snap.edges);
    const l2 = layoutMap(snap.nodes, snap.edges);
    expect(l1.nodes).toEqual(l2.nodes); // deterministic
    const high = l1.byAddress.get(DEMO_ADDRESSES.HIGH)!, low = l1.byAddress.get(DEMO_ADDRESSES.LOW)!;
    expect(high.x).toBeLessThan(low.x); // HIGH cluster is centre-left
    expect(high.r).toBeGreaterThan(low.r); // size ∝ log(usdc)
    for (let i = 0; i < l1.nodes.length; i++)
      for (let j = i + 1; j < l1.nodes.length; j++) {
        const a = l1.nodes[i], b = l1.nodes[j];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r - 1);
      }
    for (const p of l1.nodes) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(l1.width);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(l1.height);
    }
  });
});
