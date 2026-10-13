import { beforeEach, describe, expect, it, vi } from "vitest";
import "../__tests__/setup";
import { __resetConfig } from "../config";
import { __resetDb } from "../store/db";
import type { Address, Verdict } from "../types";
import { decodeBurnMessage, sourceChain } from "./abi";
import { checkSourceSender } from "./sender";
import { __resetCctpMigration, inboundEvidenceFor, inboundFor, recentInbound } from "./store";
import { decodeInbound, tailCctpOnce } from "./tailer";

// Real MessageReceived log from Arc mainnet tx 0x92cc25bc… (sourceDomain 3 = Arbitrum, 5000 USDC to 0x2166…fd67 from 0x1231…4eae)
const REAL_LOG = {
  address: "0x81d40f21f12a8f0e3252bccb954d722d4c464b64",
  topics: [
    "0xff48c13eda96b1cceacc6b9edeedc9e9db9d6226afbc30146b720c19d3addb1c",
    "0x00000000000000000000000054eae1fe03d485e6b070cdaea382aceb0570a3be",
    "0x7ae03ad1d9c14bea73dbf3223ead16e9d7111e9f0a1948bcef913fdd1c44e792",
    "0x00000000000000000000000000000000000000000000000000000000000007d0",
  ] as [`0x${string}`, ...`0x${string}`[]],
  data: ("0x" +
    "0000000000000000000000000000000000000000000000000000000000000003" + // sourceDomain
    "00000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d" + // sender (remote TokenMessengerV2)
    "0000000000000000000000000000000000000000000000000000000000000060" + // offset
    "00000000000000000000000000000000000000000000000000000000000000e4" + // len 228
    "00000001" + // version
    "000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831" + // burnToken (Arbitrum USDC)
    "0000000000000000000000002166d3a311a848d7713b6ef7a46e70f75d36fd67" + // mintRecipient
    "000000000000000000000000000000000000000000000000000000012a05f200" + // amount 5000e6
    "0000000000000000000000001231deb6f5749ef6ce6943a275a1d3e7486f4eae" + // messageSender
    "0000000000000000000000000000000000000000000000000000000000000000" + // maxFee
    "0000000000000000000000000000000000000000000000000000000000000000" + // feeExecuted
    "0000000000000000000000000000000000000000000000000000000000000000" + // expirationBlock
    "00000000000000000000000000000000000000000000000000000000") as `0x${string}`,
  transactionHash: "0x92cc25bcdeb18ef6c3612790165dfbbbdb4c6569e957279c19f6d361d1e195c3" as `0x${string}`,
  logIndex: 7,
  blockNumber: 25818818n,
};

function logWith(over: { sender?: string; recipient?: string; amount?: bigint; domain?: number; tx?: string; block?: bigint; logIndex?: number }) {
  const w = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
  const body =
    "00000001" + w("af88d065e77c8cc2239327c5edb3a432268e5831") + w(over.recipient ?? "2166d3a311a848d7713b6ef7a46e70f75d36fd67") +
    w((over.amount ?? 5_000_000_000n).toString(16)) + w(over.sender ?? "1231deb6f5749ef6ce6943a275a1d3e7486f4eae") + w("0") + w("0") + w("0") + "0".repeat(56);
  return {
    ...REAL_LOG,
    data: ("0x" + w((over.domain ?? 3).toString(16)) + w("28b5a0e9c621a5badaa536219b3a228c8168cf5d") + w("60") + w("e4") + body) as `0x${string}`,
    transactionHash: (over.tx ?? REAL_LOG.transactionHash) as `0x${string}`,
    blockNumber: over.block ?? REAL_LOG.blockNumber,
    logIndex: over.logIndex ?? REAL_LOG.logIndex,
  };
}

const SANCTIONED = "0x098b716b8aaf21512996dc57eb0615e2383e2f96"; // Ronin Bridge exploiter, OFAC SDN

describe("cctp decode", () => {
  it("decodes a real Arc MessageReceived log into an inbound mint", () => {
    const m = decodeInbound(REAL_LOG);
    expect(m).not.toBeNull();
    expect(m!.sourceDomain).toBe(3);
    expect(m!.sourceChain).toBe("arbitrum");
    expect(m!.remoteMessenger).toBe("0x28b5a0e9c621a5badaa536219b3a228c8168cf5d");
    expect(m!.burnToken).toBe("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
    expect(m!.recipient).toBe("0x2166d3a311a848d7713b6ef7a46e70f75d36fd67");
    expect(m!.sourceSender).toBe("0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae");
    expect(m!.amount).toBe(5_000_000_000n);
    expect(m!.amountUsdc).toBe("5000.000000");
    expect(m!.txHash).toBe(REAL_LOG.transactionHash);
  });
  it("rejects short / non-v1 bodies", () => {
    expect(decodeBurnMessage("0x1234")).toBeNull();
    expect(decodeInbound({ ...REAL_LOG, data: "0x" })).toBeNull();
  });
  it("maps domains to chains (unknown → domain-N)", () => {
    expect(sourceChain(0).name).toBe("ethereum");
    expect(sourceChain(6).usdc).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(sourceChain(26).name).toBe("arc");
    expect(sourceChain(99).name).toBe("domain-99");
  });
});

describe("cctp sender checks", () => {
  it("flags a sanctioned sender (yente hit) and a blacklisted one (source-chain isBlacklisted)", async () => {
    const yente = vi.fn(async () => new Response(JSON.stringify({ responses: { "a:0": { results: [{ id: "ofac-1", caption: "Lazarus", datasets: ["us_ofac_sdn"], score: 1, match: true }] } } }), { status: 200 }));
    const s = await checkSourceSender(SANCTIONED, 6, { fetchImpl: yente as never, clientFor: () => ({ readContract: vi.fn(async () => false) }) as never });
    expect(s.flagged).toBe(true);
    expect(s.sanctions[0]?.datasets).toEqual(["us_ofac_sdn"]);
    expect(s.checks).toEqual({ sanctions: "ok", blacklist: "ok" });

    const none = vi.fn(async () => new Response(JSON.stringify({ responses: {} }), { status: 200 }));
    const b = await checkSourceSender("0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", 6, { fetchImpl: none as never, clientFor: () => ({ readContract: vi.fn(async () => true) }) as never });
    expect(b.flagged).toBe(true);
    expect(b.blacklisted).toBe(true);
  });
  it("degrades: yente down + RPC error → not flagged, statuses recorded; no RPC for the chain → blacklist skipped", async () => {
    const down = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const s = await checkSourceSender("0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", 6, { fetchImpl: down as never, clientFor: () => ({ readContract: vi.fn(async () => { throw new Error("rpc"); }) }) as never, timeoutMs: 200 });
    expect(s.flagged).toBe(false);
    expect(s.checks.sanctions).toBe("ok"); // yente unreachable → [] (same semantics as the subject screen)
    expect(s.checks.blacklist).toBe("timeout_or_error");
    const sol = await checkSourceSender("0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", 5, { fetchImpl: down as never, timeoutMs: 200 });
    expect(sol.checks.blacklist).toBe("skipped");
  });
});

describe("cctp tailer", () => {
  beforeEach(() => { __resetConfig(); __resetDb(); __resetCctpMigration(); });

  function client(logs: unknown[], head = 25818900n) {
    return {
      getBlockNumber: vi.fn(async () => head),
      getLogs: vi.fn(async () => logs),
      getBlock: vi.fn(async () => ({ timestamp: 1_760_400_000n })),
    } as never;
  }
  const fakeVerdict = (address: Address, score = 5): Verdict => ({ address, score, tier: score > 60 ? "HIGH" : score > 20 ? "MEDIUM" : "LOW", decisionId: `dec_${address.slice(2, 8)}`, reasons: [] } as never);

  it("records inbound ≥ min, screens recipient (clientId cctp), checks sender, flags, and exposes evidence + API rows", async () => {
    const logs = [
      logWith({ sender: SANCTIONED.slice(2), recipient: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", tx: "0x" + "a1".repeat(32), block: 25818810n }),
      logWith({ recipient: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", amount: 50_000_000n, tx: "0x" + "b2".repeat(32), block: 25818811n }), // 50 USDC < min
      logWith({ recipient: "cccccccccccccccccccccccccccccccccccccccc", tx: "0x" + "c3".repeat(32), block: 25818812n, domain: 6 }),
    ];
    const screenFn = vi.fn(async (req: { address: Address; clientId?: string }) => fakeVerdict(req.address));
    const yente = vi.fn(async (_url: string, init: { body: string }) => {
      const hit = init.body.includes(SANCTIONED);
      return new Response(JSON.stringify({ responses: hit ? { "a:0": { results: [{ id: "ofac-1", caption: "Lazarus", datasets: ["us_ofac_sdn"], score: 1, match: true }] } } : {} }), { status: 200 });
    });
    const r = await tailCctpOnce({
      client: client(logs), screenFn, fromBlock: 25818800, toBlock: 25818899, now: 1_760_400_100,
      sender: { fetchImpl: yente as never, clientFor: () => ({ readContract: vi.fn(async () => false) }) as never },
    });
    expect(r.logs).toBe(3);
    expect(r.mints).toBe(3);
    expect(r.belowMin).toBe(1);
    expect(r.recorded).toBe(2);
    expect(r.screened).toBe(2);
    expect(r.flagged).toBe(1);
    expect(r.cursorBlock).toBe(25818899);
    expect(screenFn).toHaveBeenCalledTimes(2);
    expect(screenFn.mock.calls[0][0].clientId).toBe("cctp");

    const rows = await recentInbound(10);
    expect(rows).toHaveLength(2);
    const flagged = rows.find((x) => x.flagged)!;
    expect(flagged.recipient).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(flagged.sourceSender).toBe(SANCTIONED);
    expect(flagged.sourceChain).toBe("arbitrum");
    expect(flagged.senderSanctions[0]?.datasets).toEqual(["us_ofac_sdn"]);
    expect(flagged.recipientTier).toBe("LOW");
    expect(flagged.recipientDecisionId).toBe("dec_aaaaaa");
    expect(flagged.blockTime).toBe(1_760_400_000);

    const ev = await inboundEvidenceFor("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { now: 1_760_400_200 });
    expect(ev).toEqual({ flaggedCount: 1, lastAt: 1_760_400_000, sources: ["arbitrum"], windowDays: 30, seen: 1 });
    const clean = await inboundEvidenceFor("0xcccccccccccccccccccccccccccccccccccccccc", { now: 1_760_400_200 });
    expect(clean?.flaggedCount).toBe(0);
    expect(await inboundEvidenceFor("0x0000000000000000000000000000000000000001")).toBeNull();
    expect((await inboundFor("0xcccccccccccccccccccccccccccccccccccccccc"))[0]?.sourceChain).toBe("base");

    // idempotent: second tick over the same range records nothing new
    const again = await tailCctpOnce({ client: client(logs), screenFn, fromBlock: 25818800, toBlock: 25818899, now: 1_760_400_100, sender: { fetchImpl: yente as never, clientFor: () => ({ readContract: vi.fn(async () => false) }) as never } });
    expect(again.recorded).toBe(0);
    expect(again.skippedSeen).toBe(2);
  });

  it("stops at the screen budget and parks the cursor before the unprocessed mint; reuses a fresh recipient verdict", async () => {
    const logs = [
      logWith({ recipient: "dddddddddddddddddddddddddddddddddddddddd", tx: "0x" + "d1".repeat(32), block: 25818820n }),
      logWith({ recipient: "dddddddddddddddddddddddddddddddddddddddd", tx: "0x" + "d2".repeat(32), block: 25818821n }), // same recipient → reuse
      logWith({ recipient: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", tx: "0x" + "e3".repeat(32), block: 25818830n }), // over budget
    ];
    const screenFn = vi.fn(async (req: { address: Address }) => fakeVerdict(req.address));
    const none = vi.fn(async () => new Response(JSON.stringify({ responses: {} }), { status: 200 }));
    const r = await tailCctpOnce({ client: client(logs), screenFn, fromBlock: 25818800, toBlock: 25818899, maxScreens: 1, now: 1_760_400_100, sender: { fetchImpl: none as never, clientFor: () => null } });
    expect(r.screened).toBe(1);
    expect(r.reused).toBe(1);
    expect(r.recorded).toBe(2);
    expect(r.partial).toBe(true);
    expect(r.cursorBlock).toBe(25818829);
  });

  it("survives a getLogs failure (no cursor advance, error recorded)", async () => {
    const c = { getBlockNumber: vi.fn(async () => 25818900n), getLogs: vi.fn(async () => { throw new Error("boom"); }), getBlock: vi.fn() } as never;
    const r = await tailCctpOnce({ client: c, screenFn: vi.fn() as never, fromBlock: 25818800, toBlock: 25818899 });
    expect(r.partial).toBe(true);
    expect(r.error).toContain("boom");
    expect(r.cursorBlock).toBeNull();
  });
});
