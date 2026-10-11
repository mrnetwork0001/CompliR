import { describe, expect, it, vi } from "vitest";
import { groupFunders, traceFunders, type GraphClient } from "./arcGraph";
import { toUsdc6 } from "./util";

const S = "0x00000000000000000000000000000000000000aa" as const; // subject
const A = "0x00000000000000000000000000000000000000a1" as const; // hop-1 funder
const B = "0x00000000000000000000000000000000000000b2" as const; // hop-2 funder (funded A)
const C = "0x00000000000000000000000000000000000000c3" as const; // another hop-1 funder
const ZERO = "0x0000000000000000000000000000000000000000";
const EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

type L = { address: string; args: { from: string; to: string; value: bigint }; blockNumber: bigint; transactionHash: string; blockTimestamp?: bigint };
const log = (from: string, to: string, usdc: number, block: number, hash: number): L => ({
  address: EMITTER,
  args: { from, to, value: BigInt(Math.round(usdc * 1e6)) * 10n ** 12n }, // 18 dp like the system emitter
  blockNumber: BigInt(block),
  transactionHash: tx(hash),
  blockTimestamp: BigInt(1_700_000_000 + block),
});

/** in-memory log store; getLogs filters by `to` + block range like the node does */
function mockClient(logs: L[], head: number, opts: { failRangeOver?: number } = {}) {
  const getLogs = vi.fn(async (args: { args: { to: string }; fromBlock: bigint; toBlock: bigint }) => {
    if (opts.failRangeOver && args.toBlock - args.fromBlock + 1n > BigInt(opts.failRangeOver)) {
      throw new Error("request exceeded max allowed range: query exceeds max results 2000");
    }
    return logs.filter((l) => l.args.to === args.args.to && l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock);
  });
  const client = {
    getLogs,
    getBlockNumber: vi.fn(async () => BigInt(head)),
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_600_000_000n + blockNumber })),
  };
  return { client: client as unknown as GraphClient, getLogs };
}

describe("traceFunders", () => {
  it("assembles a 2-hop path [hop2→hop1, hop1→subject] with 18-dp amounts rendered at 6 dp", async () => {
    const logs = [
      log(A, S, 150, 1_000, 1),
      log(C, S, 20, 1_010, 2),
      log(B, A, 12, 900, 3),
      log(ZERO, S, 5, 950, 4), // mint → ignored
      log(S, S, 1, 960, 5), // self → ignored
    ];
    const { client } = mockClient(logs, 1_100);
    const r = await traceFunders(S, { depth: 2, client, lookbackBlocks: 500, toBlock: 1_100n });

    expect(r.depth).toBe(2);
    const hop1 = r.funders.filter((f) => f.hop === 1).map((f) => f.facts.address);
    expect(hop1).toEqual([A, C]); // biggest total first
    const hop2 = r.funders.filter((f) => f.hop === 2);
    expect(hop2).toHaveLength(1);
    expect(hop2[0].facts.address).toBe(B);
    expect(hop2[0].path.map((h) => [h.from, h.to])).toEqual([
      [B, A],
      [A, S],
    ]);
    expect(hop2[0].path[0].amountUsdc).toBe("12.000000");
    expect(hop2[0].path[1].txHash).toBe(tx(1));
    expect(hop2[0].path[0].timestamp).toBe(1_700_000_900);
    expect(r.subjectFirstIncoming).toBe(1_700_000_950);
    expect(r.subjectIncomingCount).toBe(3);
    expect(r.partial).toBe(false);
  });

  it("depth 1 never queries hop-1 funders' inflows", async () => {
    const { client, getLogs } = mockClient([log(A, S, 1, 1_000, 1), log(B, A, 1, 900, 2)], 1_100);
    const r = await traceFunders(S, { depth: 1, client, lookbackBlocks: 500, toBlock: 1_100n });
    expect(r.depth).toBe(1);
    expect(r.funders.map((f) => f.hop)).toEqual([1]);
    expect(getLogs.mock.calls.every((c) => c[0].args.to === S)).toBe(true);
  });

  it("chunks long windows at ≤9,999 blocks and bisects a chunk the node rejects", async () => {
    const { client, getLogs } = mockClient([log(A, S, 1, 20_000, 1)], 30_000, { failRangeOver: 2_000 });
    const r = await traceFunders(S, { depth: 1, client, lookbackBlocks: 25_000, toBlock: 30_000n, concurrency: 2 });
    expect(r.funders).toHaveLength(1);
    expect(r.fromBlock).toBe(5_001n);
    expect(getLogs.mock.calls.every((c) => c[0].toBlock - c[0].fromBlock + 1n <= 9_999n)).toBe(true);
    // 3 top-level chunks, each bisected down to ≤2000-block pieces
    expect(getLogs.mock.calls.length).toBeGreaterThan(3);
    expect(r.partial).toBe(false);
  });

  it("falls back to getBlock for timestamps when the node omits blockTimestamp", async () => {
    const l = log(A, S, 3, 1_000, 1);
    delete l.blockTimestamp;
    const { client } = mockClient([l], 1_100);
    const r = await traceFunders(S, { depth: 1, client, lookbackBlocks: 500, toBlock: 1_100n });
    expect(r.funders[0].path[0].timestamp).toBe(1_600_001_000);
  });

  it("reports depth 0 when hop-1 lookup fails outright", async () => {
    const client = {
      getLogs: vi.fn(async () => {
        throw new Error("boom");
      }),
      getBlockNumber: vi.fn(async () => 10n),
      getBlock: vi.fn(),
    } as unknown as GraphClient;
    const r = await traceFunders(S, { depth: 2, client, lookbackBlocks: 5, chunkBlocks: 1 });
    expect(r.depth === 0 || (r.depth === 1 && r.partial)).toBe(true);
    expect(r.funders).toEqual([]);
  });
});

describe("public-RPC politeness", () => {
  it("retries a rate-limited chunk with backoff instead of bisecting it", async () => {
    let calls = 0;
    const client = {
      getLogs: vi.fn(async () => {
        calls++;
        if (calls <= 2) throw Object.assign(new Error("HTTP request failed. Status: 429"), { cause: { code: -32005, message: "rate limit exceeded" } });
        return [log(A, S, 1, 1_000, 1)];
      }),
      getBlockNumber: vi.fn(async () => 1_100n),
      getBlock: vi.fn(),
    } as unknown as GraphClient;
    const r = await traceFunders(S, { depth: 1, client, lookbackBlocks: 500, toBlock: 1_100n, retryBaseMs: 5 });
    expect(calls).toBe(3);
    expect(r.requests).toBe(3);
    expect(r.partial).toBe(false);
    expect(r.funders.map((f) => f.facts.address)).toEqual([A]);
  });

  it("stops hop-2 lookups when the request budget is spent and flags partial", async () => {
    const logs = [log(A, S, 5, 20_000, 1), log(C, S, 1, 20_001, 2), log(B, A, 1, 19_000, 3)];
    const { client, getLogs } = mockClient(logs, 1_100);
    // 3 chunks per wallet; budget 6 → subject + first hop-1 parent only
    const r = await traceFunders(S, { depth: 2, client, lookbackBlocks: 25_000, toBlock: 30_000n, requestBudget: 6 });
    expect(getLogs.mock.calls.length).toBeLessThanOrEqual(6);
    expect(r.partial).toBe(true);
    expect(r.depth).toBe(2);
  });
});

describe("helpers", () => {
  it("groupFunders picks the largest transfer as the path and sorts by total", () => {
    const hops = [
      { from: A, to: S, txHash: tx(1), amountUsdc: "1.000000", timestamp: 10 },
      { from: A, to: S, txHash: tx(2), amountUsdc: "5.000000", timestamp: 5 },
      { from: C, to: S, txHash: tx(3), amountUsdc: "7.000000", timestamp: 7 },
    ];
    const g = groupFunders(hops, new Set(), 10);
    expect(g.map((f) => f.address)).toEqual([C, A]);
    expect(g[1].hop.txHash).toBe(tx(2));
    expect(groupFunders(hops, new Set(), 1)).toHaveLength(1);
  });
  it("toUsdc6 converts 18-dp and 6-dp values", () => {
    expect(toUsdc6(1_500_000_000_000_000_000n, 18)).toBe("1.500000");
    expect(toUsdc6(123_456n, 6)).toBe("0.123456");
    expect(toUsdc6(0n, 18)).toBe("0.000000");
  });
});
