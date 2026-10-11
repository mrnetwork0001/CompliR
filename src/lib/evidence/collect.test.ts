import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EvidenceClient } from "./collect";

process.env.ARC_CHAIN_ID ??= "5042002";
process.env.ARC_RPC_URL ??= "https://rpc.testnet.arc.io";
process.env.USDC_ADDRESS ??= "0x3600000000000000000000000000000000000000";
delete process.env.ARC_BLOCKSCOUT_API;

const { collectEvidenceDetailed } = await import("./collect");
const { parseOverrides } = await import("./overrides");
const { scoreEvidence } = await import("../scoring/rules");

const S = "0x00000000000000000000000000000000000000aa" as const;
const A = "0x00000000000000000000000000000000000000a1" as const;
const B = "0x00000000000000000000000000000000000000b2" as const;
const EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const NOW = 1_760_200_000;

const log = (from: string, to: string, block: number, hash: number) => ({
  address: EMITTER,
  args: { from, to, value: 10n ** 18n },
  blockNumber: BigInt(block),
  transactionHash: tx(hash),
  blockTimestamp: BigInt(NOW - 3600),
});

function client(opts: { logs?: ReturnType<typeof log>[]; blacklisted?: string[]; hang?: boolean } = {}): EvidenceClient {
  const logs = opts.logs ?? [];
  return {
    getLogs: vi.fn(async (a: { args: { to: string }; fromBlock: bigint; toBlock: bigint }) => {
      if (opts.hang) return new Promise(() => {});
      return logs.filter((l) => l.args.to === a.args.to && l.blockNumber >= a.fromBlock && l.blockNumber <= a.toBlock);
    }),
    getBlockNumber: vi.fn(async () => 1_000n),
    getBlock: vi.fn(async () => ({ timestamp: BigInt(NOW - 3600) })),
    readContract: vi.fn(async (a: { functionName: string; args: [string] }) => {
      if (a.functionName === "isBlacklisted") return (opts.blacklisted ?? []).includes(a.args[0]);
      throw new Error("revert");
    }),
    getTransactionCount: vi.fn(async () => 3),
  } as unknown as EvidenceClient;
}

const yenteDown = vi.fn(async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

let overrides: ReturnType<typeof parseOverrides>;
beforeAll(async () => {
  const fs = await import("node:fs");
  overrides = parseOverrides(JSON.parse(fs.readFileSync(".data/overrides.json", "utf8")));
});

describe("collectEvidence", () => {
  it("traces the chain, enriches funders, and merges per-address overrides", async () => {
    const c = client({ logs: [log(A, S, 900, 1), log(B, A, 800, 2)], blacklisted: [A] });
    const r = await collectEvidenceDetailed(
      { address: S, payeeBook: [{ label: "Lela", address: "0x00000000000000000000000000000000000000ab" }] },
      { depth: 2, client: c, fetchImpl: yenteDown, overrides: { [B]: { sanctions: [{ source: "opensanctions", entityId: "NK-x", caption: "x", datasets: [], score: 1, matchedOn: "address" }] } }, now: NOW, lookbackBlocks: 500 },
    );
    const b = r.bundle;
    expect(b.depth).toBe(2);
    expect(b.funders.find((f) => f.hop === 1)?.facts.usdcBlacklisted).toBe(true);
    expect(b.funders.find((f) => f.hop === 2)?.facts.sanctions).toHaveLength(1);
    expect(b.subject.firstSeen).toBe(NOW - 3600); // from the trace (no Blockscout configured)
    expect(b.subject.txCount).toBe(4); // nonce 3 + 1 inbound seen by the trace
    expect(b.lookalikes).toHaveLength(1);
    expect(r.sources.sanctions).toBe("ok"); // yente down → [] is a valid (empty) answer, not a timeout
    expect(r.sources.trace).toBe("ok");
    expect(b.collectedAt).toBe(NOW);
    const { reasons } = scoreEvidence(b);
    expect(reasons.map((x) => x.code)).toEqual(expect.arrayContaining(["FUNDER_1HOP_BLACKLISTED", "FUNDER_2HOP_SANCTIONED", "LOOKALIKE_OF_KNOWN_PAYEE", "FRESH_WALLET"]));
  });

  it("uses override funders instead of the chain trace and never calls getLogs", async () => {
    const BEEF = "0x000000000000000000000000000000000000beef" as const;
    const c = client();
    const r = await collectEvidenceDetailed({ address: BEEF }, { depth: 2, client: c, fetchImpl: yenteDown, overrides, now: NOW });
    expect(c.getLogs).not.toHaveBeenCalled();
    expect(r.sources.trace).toBe("override");
    expect(r.bundle.depth).toBe(2);
    expect(r.bundle.funders.map((f) => f.hop)).toEqual([1, 2]);
    expect(r.bundle.subject.txCount).toBe(2);
    const { score, reasons } = scoreEvidence(r.bundle);
    expect(reasons.map((x) => x.code)).toEqual(expect.arrayContaining(["FUNDER_2HOP_SANCTIONED", "FRESH_WALLET"]));
    expect(score).toBeGreaterThanOrEqual(21);
    expect(score).toBeLessThanOrEqual(60);
  });

  it("demo overrides score HIGH (dead) and LOW (cafe)", async () => {
    const DEAD = "0x000000000000000000000000000000000000dead" as const;
    const CAFE = "0x000000000000000000000000000000000000cafe" as const;
    const c = client();
    const dead = await collectEvidenceDetailed({ address: DEAD }, { depth: 1, client: c, fetchImpl: yenteDown, overrides, now: NOW });
    expect(scoreEvidence(dead.bundle).score).toBeGreaterThanOrEqual(61);
    expect(dead.sources.usdcBlacklist).toBe("override");
    const cafe = await collectEvidenceDetailed({ address: CAFE }, { depth: 2, client: c, fetchImpl: yenteDown, overrides, now: NOW });
    expect(scoreEvidence(cafe.bundle).reasons.map((r) => r.code)).toEqual(["CLEAN"]);
  });

  it("a hanging RPC hits the per-source timeout and yields a neutral bundle with depth 0", async () => {
    const c = client({ hang: true });
    const r = await collectEvidenceDetailed({ address: S }, { depth: 2, client: c, fetchImpl: yenteDown, overrides: {}, now: NOW, timeoutMs: 30 });
    expect(r.sources.trace).toBe("timeout_or_error");
    expect(r.bundle.depth).toBe(0);
    expect(r.bundle.funders).toEqual([]);
    expect(r.bundle.subject.usdcBlacklisted).toBe(false);
  });

  it("depth 1 drops hop-2 entries from override funders too", async () => {
    const BEEF = "0x000000000000000000000000000000000000beef" as const;
    const r = await collectEvidenceDetailed({ address: BEEF }, { depth: 1, client: client(), fetchImpl: yenteDown, overrides, now: NOW });
    expect(r.bundle.depth).toBe(1);
    expect(r.bundle.funders.map((f) => f.hop)).toEqual([1]);
  });
});
