import "../__tests__/setup";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { listDecisions } from "../ledger";
import { db } from "../store/db";
import { upsertWatch } from "../store/repo";
import { getNode, listTierChanges, migrateTrustmap, upsertNode } from "../trustmap/store";
import type { Address, ScreenRequest, Verdict } from "../types";
import { kindOf, pollBlocklistEvents, simulateBlocklistEvent, type EventsClient, type ScreenFn } from "./blocklist";
import { activeWatchesFor, getEventsCursor, listEventLogs, migrateEvents } from "./store";

const USDC = "0x0000000000000000000000000000000000000001" as Address; // setup.ts USDC_ADDRESS
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const NOW = Math.floor(Date.now() / 1000); // real "now": watches expire 30 d after creation

const W = addr(0x3a7); // watched
const M = addr(0x3a8); // on the trust map
const R = addr(0x3a9); // screened recently by someone
const U = addr(0x3aa); // unknown to us

type L = { address: Address; eventName: string; args: { _account: Address }; blockNumber: bigint; transactionHash: `0x${string}`; logIndex: number };
const log = (eventName: string, account: Address, block: number, hash: number, logIndex = 0): L => ({
  address: USDC, eventName, args: { _account: account }, blockNumber: BigInt(block), transactionHash: tx(hash), logIndex,
});

function mockClient(logs: L[], head: number, opts: { failRangeOver?: number } = {}) {
  const getLogs = vi.fn(async (args: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
    expect(args.address).toBe(USDC);
    if (opts.failRangeOver && args.toBlock - args.fromBlock + 1n > BigInt(opts.failRangeOver)) throw new Error("query exceeds max results 2000");
    return logs.filter((l) => l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock);
  });
  const getBlockNumber = vi.fn(async () => BigInt(head));
  return { client: { getLogs, getBlockNumber } as unknown as EventsClient, getLogs, getBlockNumber };
}

function verdict(address: Address, tier: Verdict["tier"], score: number): Verdict {
  return {
    address, score, tier, recommendedLimits: { maxPerTxUsdc: 100, maxPerDayUsdc: 1000 },
    reasons: [{ code: tier === "HIGH" ? "USDC_BLACKLISTED" : "CLEAN", weight: score, evidence: {} }], rationale: `mock ${tier}`, eddRequested: [],
    nextRescreenAt: new Date((NOW + 3600) * 1000).toISOString(),
    attestation: { typedData: {} as Verdict["attestation"]["typedData"], signature: "0x00", attester: addr(0xa77), validUntil: 0, registryTx: null },
    decisionId: `dec_${address.slice(-3)}_${tier}`, screenedAt: new Date(NOW * 1000).toISOString(),
    evidence: {
      subject: { address, firstSeen: null, txCount: 0, usdcBlacklisted: tier === "HIGH", protocolBlocklisted: false, sanctions: [] },
      funders: [], lookalikes: [], payeeChanged: null, concentration: null, priorTier: null, collectedAt: NOW, depth: 1,
    },
  };
}

let tierFor: Record<string, Verdict["tier"]> = {};
const screenCalls: ScreenRequest[] = [];
const screenFn: ScreenFn = vi.fn(async (req: ScreenRequest) => {
  screenCalls.push(req);
  const t = tierFor[req.address] ?? "LOW";
  return verdict(req.address, t, t === "HIGH" ? 100 : 0);
});
const hooks: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  hooks.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
  return new Response("ok", { status: 200 });
}) as unknown as typeof fetch;

beforeAll(async () => {
  await migrateEvents();
  await migrateTrustmap();
  await upsertWatch({ address: W, webhookUrl: "https://hooks.example/a", clientId: "treasury-a" });
  await upsertWatch({ address: W, webhookUrl: "https://hooks.example/b", clientId: "treasury-b" });
  await db().execute({ sql: `UPDATE watches SET last_tier = 'LOW' WHERE address = ?`, args: [W] });
  await upsertNode({ address: M, tier: "LOW", score: 0, lastSeenBlock: 10, usdcIn24h: 50, reasonCodes: ["CLEAN"], rationale: null, decisionId: null, at: NOW - 100 });
  await db().execute({
    sql: `INSERT INTO screenings (subject, client_id, score, tier, reason_codes, decision_id, payer, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    args: [R, "client-x", 0, "LOW", "[]", "dec_r", "outside", NOW - 5 * 86_400],
  });
});

describe("kindOf", () => {
  it("maps all four event names", () => {
    expect(kindOf("Blacklisted")).toBe("BLOCKLISTED");
    expect(kindOf("Blocklisted")).toBe("BLOCKLISTED");
    expect(kindOf("UnBlacklisted")).toBe("UNBLOCKLISTED");
    expect(kindOf("UnBlocklisted")).toBe("UNBLOCKLISTED");
  });
});

describe("pollBlocklistEvents", () => {
  it("re-screens watched / graded / recently screened addresses, pushes webhooks, ignores strangers, advances the cursor", async () => {
    tierFor = { [W]: "HIGH", [M]: "HIGH", [R]: "HIGH", [U]: "HIGH" };
    const { client, getLogs } = mockClient(
      [log("Blacklisted", W, 990, 1), log("Blacklisted", M, 991, 2), log("Blocklisted", R, 992, 3), log("Blacklisted", U, 993, 4)],
      1000,
    );
    const r = await pollBlocklistEvents({ client, screenFn, fetchImpl, now: NOW, maxBlocks: 500, retryBaseMs: 1 });
    expect(r.error).toBeNull();
    expect([r.fromBlock, r.toBlock, r.blocksScanned, r.head]).toEqual([501, 1000, 500, 1000]);
    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(r.logs).toBe(4);
    expect(r.ignored).toBe(1); // U
    expect(r.handled.map((h) => [h.address, h.matched, h.kind])).toEqual([
      [W, ["watched"], "BLOCKLISTED"],
      [M, ["trustmap"], "BLOCKLISTED"],
      [R, ["screened"], "BLOCKLISTED"],
    ]);
    // every re-screen goes through the pipeline as the internal "events" client, kind RESCREEN
    expect(screenCalls.map((c) => c.clientId)).toEqual(["events", "events", "events"]);
    expect(screenCalls.map((c) => c.address)).toEqual([W, M, R]);
    // both watches on W were pushed, LOW → HIGH, with the tier.changed envelope and no evidence blob
    expect(r.webhooks).toBe(2);
    expect(hooks.map((h) => h.url).sort()).toEqual(["https://hooks.example/a", "https://hooks.example/b"]);
    expect(hooks[0].headers["x-complir-event"]).toBe("tier.changed");
    expect(hooks[0].body).toMatchObject({ type: "tier.changed", address: W, from: "LOW", to: "HIGH" });
    expect((hooks[0].body.verdict as Record<string, unknown>).evidence).toBeUndefined();
    const wEntry = r.handled[0];
    expect([wEntry.tierFrom, wEntry.tierTo, wEntry.webhooks, wEntry.watches, wEntry.rescreened]).toEqual([null, "HIGH", 2, 2, true]);
    // watches now remember HIGH
    expect((await activeWatchesFor(W, NOW)).map((w) => w.lastTier)).toEqual(["HIGH", "HIGH"]);
    // trust map node regraded in place + tier change recorded
    expect((await getNode(M))?.tier).toBe("HIGH");
    expect((await listTierChanges(5)).some((c) => c.address === M && c.from === "LOW" && c.to === "HIGH")).toBe(true);
    // ledger: TIER_CHANGE per pushed watch (W ×2) + subject-level for M and R (no watches)
    const tc = (await listDecisions({ limit: 50 })).filter((d) => d.kind === "TIER_CHANGE");
    expect(tc.filter((d) => d.subject === W).length).toBe(2);
    expect(tc.filter((d) => d.subject === M).length).toBe(1);
    expect(tc.filter((d) => d.subject === R).length).toBe(1);
    // cursor advanced; the ignored event is logged too
    expect(await getEventsCursor()).toBe(1000);
    expect(r.cursorBlock).toBe(1000);
    const logged = await listEventLogs(10);
    expect(logged.length).toBe(4);
    expect(logged.find((e) => e.address === U)).toMatchObject({ matched: [], rescreened: false, simulated: false, txHash: tx(4) });
  });

  it("next tick starts after the cursor and does not re-handle old logs; same tier → no webhook", async () => {
    hooks.length = 0;
    screenCalls.length = 0;
    const { client, getLogs } = mockClient([log("Blacklisted", W, 990, 1), log("UnBlacklisted", W, 1005, 5)], 1010);
    const r = await pollBlocklistEvents({ client, screenFn, fetchImpl, now: NOW + 60, maxBlocks: 500, retryBaseMs: 1 });
    expect(getLogs.mock.calls[0][0]).toMatchObject({ fromBlock: 1001n, toBlock: 1010n });
    expect(r.logs).toBe(1);
    expect(r.handled.map((h) => [h.kind, h.tierFrom, h.tierTo])).toEqual([["UNBLOCKLISTED", null, "HIGH"]]); // mock still says HIGH
    expect(r.webhooks).toBe(0);
    expect(hooks.length).toBe(0);
    expect(await getEventsCursor()).toBe(1010);
    // re-running the same window (explicit fromBlock) is idempotent thanks to (tx, logIndex)
    const again = await pollBlocklistEvents({ client, screenFn, fetchImpl, now: NOW + 61, fromBlock: 1001n, maxBlocks: 500, retryBaseMs: 1 });
    expect(again.duplicates).toBe(1);
    expect(again.handled.length).toBe(0);
  });

  it("nothing new → no scan, cursor untouched; a result-cap error bisects", async () => {
    const idle = await pollBlocklistEvents({ client: mockClient([], 1010).client, screenFn, fetchImpl, now: NOW + 120, maxBlocks: 500 });
    expect(idle.blocksScanned).toBe(0);
    expect(await getEventsCursor()).toBe(1010);
    const { client, getLogs } = mockClient([], 1410, { failRangeOver: 200 });
    const r = await pollBlocklistEvents({ client, screenFn, fetchImpl, now: NOW + 180, maxBlocks: 400, retryBaseMs: 1 });
    expect(getLogs.mock.calls.length).toBeGreaterThan(1);
    expect(r.partial).toBe(false);
    expect(await getEventsCursor()).toBe(1410);
  });

  it("skips ahead when the cursor is far behind head (live reactor, not an indexer)", async () => {
    const { client, getLogs } = mockClient([], 50_000);
    const r = await pollBlocklistEvents({ client, screenFn, fetchImpl, now: NOW + 240, maxBlocks: 500, maxLag: 5000 });
    expect(r.skippedAhead).toBe(true);
    expect(getLogs.mock.calls[0][0]).toMatchObject({ fromBlock: 49_501n, toBlock: 50_000n });
  });
});

describe("simulateBlocklistEvent (blacklist drill)", () => {
  it("runs the same handler without a chain event: re-screen, webhooks on change, events_log marked simulated", async () => {
    hooks.length = 0;
    tierFor = { [W]: "LOW" }; // "unblocklisted" per the overrides file → tier drops back
    const e = await simulateBlocklistEvent(W, "UNBLOCKLISTED", { screenFn, fetchImpl, now: NOW + 300 });
    expect(e).toMatchObject({ simulated: true, eventName: "Simulated", kind: "UNBLOCKLISTED", address: W, matched: ["watched"], rescreened: true, tierTo: "LOW", webhooks: 2, watches: 2, txHash: null });
    expect(hooks.map((h) => h.body.to)).toEqual(["LOW", "LOW"]);
    expect(hooks[0].body.from).toBe("HIGH");
    const logged = await listEventLogs(1);
    expect(logged[0]).toMatchObject({ simulated: true, address: W, id: e.id });
  });
  it("an address nobody cares about is logged as ignored and not screened", async () => {
    screenCalls.length = 0;
    const e = await simulateBlocklistEvent(addr(0x7777), "BLOCKLISTED", { screenFn, fetchImpl, now: NOW + 301 });
    expect(e.matched).toEqual([]);
    expect(e.rescreened).toBe(false);
    expect(screenCalls.length).toBe(0);
  });
  it("a failing screen lands in the row, never throws", async () => {
    const boom: ScreenFn = async () => { throw new Error("rpc down"); };
    const e = await simulateBlocklistEvent(W, "BLOCKLISTED", { screenFn: boom, fetchImpl, now: NOW + 302 });
    expect(e.rescreened).toBe(false);
    expect(e.error).toBe("rpc down");
  });
});
