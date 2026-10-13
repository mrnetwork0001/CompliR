/**
 * Event-driven tier changes (docs/SUGGESTIONS.md §G item 38): tail the USDC blocklist events on Arc and, within one
 * poll interval, re-screen every address we care about and push `tier.changed` to every integrator watching it.
 *
 * Which events. Arc's docs call the list the "USDC blocklist" (Blocklisted/UnBlocklisted) but the deployed
 * implementation is Circle's FiatToken: on mainnet the proxy 0x3600…0000 (impl 0xc6ad…3ca6, FiatTokenProxy slot
 * 0x7050c9e0…) contains the topic hashes of `Blacklisted(address indexed _account)` / `UnBlacklisted(address …)`
 * and NOT of Blocklisted/UnBlocklisted (verified by bytecode inspection 2026-10-13). Logs surface at the PROXY
 * address (delegatecall), so we filter on USDC_ADDRESS with all four event names - whichever variant a future
 * upgrade emits is caught, and `eventName` is recorded as seen. The system emitter 0xffff…fffE only logs
 * Transfer, so it is not consulted here.
 *
 * Relevance. An affected address is re-screened when it is (a) watched (`watches`), (b) on the Trust Map
 * (`trustmap_nodes`), or (c) screened by anyone in the last EVENTS_SCREENED_DAYS. Everything else is logged as
 * ignored. The re-screen goes through the real pipeline (`screen({address, clientId: "events"}, {kind: "RESCREEN"})`)
 * so the verdict is attested, ledgered and mirrored to the registry like any other; "events" is an internal client
 * id (store/repo INTERNAL_CLIENT_IDS) so these screens never count as traction or as "held elsewhere".
 *
 * Cursor: events_meta.cursor_block, advanced only through contiguously fetched blocks; a lag > EVENTS_MAX_LAG skips
 * ahead (this is a live reactor, not an indexer - the cadence watcher remains the baseline).
 *
 * Drill (no real blocklist event needed): `simulateBlocklistEvent(addr)` runs the identical handler. The re-screen
 * reads the chain, so for the verdict to flip the address must read as blocklisted - put
 *   { "<addr>": { "usdcBlacklisted": true } }   in .data/overrides.json (or OVERRIDES_JSON)
 * first (overrides merge over live facts, src/lib/evidence/overrides.ts). Remove it and simulate again with
 * kind "UNBLOCKLISTED" to show the tier dropping back.
 */
import { parseAbi, type PublicClient } from "viem";
import { config } from "../config";
import { arcClient } from "../evidence/rpc";
import { isRangeError, isRateLimited, lower, rpcGate, rpcRetry, type Limiter } from "../evidence/util";
import { appendDecision } from "../ledger";
import { screen as pipelineScreen, type ScreenOptions } from "../pipeline";
import { latestAttestation, updateWatchAfterRescreen } from "../store";
import { getNode, insertTierChange, upsertNode } from "../trustmap/store";
import type { Address, ScreenRequest, Tier, Verdict } from "../types";
import { pushTierChange } from "../watcher";
import { eventsEnv } from "./env";
import {
  activeWatchesFor, getEventsCursor, hasHandledLog, insertEventLog, screenedSince, setEventsCursor, setEventsMeta,
  type BlocklistEventKind, type EventLogEntry, type EventMatch,
} from "./store";

export const BLOCKLIST_EVENTS = parseAbi([
  "event Blacklisted(address indexed _account)",
  "event UnBlacklisted(address indexed _account)",
  "event Blocklisted(address indexed _account)",
  "event UnBlocklisted(address indexed _account)",
]);
export const BLOCKLIST_EVENT_NAMES = ["Blacklisted", "UnBlacklisted", "Blocklisted", "UnBlocklisted"] as const;

export type EventsClient = Pick<PublicClient, "getBlockNumber" | "getLogs">;
export type ScreenFn = (req: ScreenRequest, opts: ScreenOptions) => Promise<Verdict>;

export interface BlocklistEvent {
  kind: BlocklistEventKind;
  eventName: string;
  address: Address;
  block: number | null;
  txHash: `0x${string}` | null;
  logIndex: number | null;
  simulated: boolean;
}

export interface HandlerDeps {
  screenFn?: ScreenFn;
  fetchImpl?: typeof fetch;
  now?: number;
  screenedDays?: number;
}

export interface RescreenResult {
  verdict: Verdict;
  from: Tier | null;
  to: Tier;
  changed: boolean;
  watches: number;
  webhooks: number;
}

/**
 * Re-screen `address` right now (client-neutral, clientId "events"), then for every active watch whose last known
 * tier differs push the webhook (ledger TIER_CHANGE per watch, via the watcher's pushTierChange). When nobody
 * watches but the tier moved against the latest attestation, one subject-level TIER_CHANGE is still ledgered.
 * A Trust Map node is regraded in place so /map reflects the event too.
 */
export async function rescreenAddressNow(address: Address, reason: string, deps: HandlerDeps = {}): Promise<RescreenResult> {
  const addr = lower(address);
  const screenFn = deps.screenFn ?? pipelineScreen;
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const prior = await latestAttestation(addr).catch(() => null);
  const watches = await activeWatchesFor(addr, now);
  const verdict = await screenFn({ address: addr, clientId: "events" }, { kind: "RESCREEN" });
  const next = Math.floor(new Date(verdict.nextRescreenAt).getTime() / 1000);
  const from: Tier | null = prior?.tier ?? null;
  const changed = from !== verdict.tier;

  let webhooks = 0;
  for (const w of watches) {
    const wFrom = w.lastTier ?? from;
    if (wFrom !== verdict.tier) {
      if (await pushTierChange(w, verdict, wFrom, { trigger: reason, fetchImpl: deps.fetchImpl })) webhooks++;
    }
    await updateWatchAfterRescreen(w.id, verdict.tier, Number.isFinite(next) ? next : now + 3600).catch(() => undefined);
  }
  if (changed && watches.length === 0) {
    await appendDecision({ kind: "TIER_CHANGE", subject: addr, clientId: "events", payload: { from, to: verdict.tier, decisionId: verdict.decisionId, trigger: reason } });
  }

  // Trust Map: regrade in place when the address is a graded node (never adds nodes - that's the tailer's job).
  try {
    const node = await getNode(addr);
    if (node) {
      const { changed: nodeChanged } = await upsertNode({
        address: addr, tier: verdict.tier, score: verdict.score, lastSeenBlock: node.lastSeenBlock, usdcIn24h: node.usdcIn24h,
        reasonCodes: verdict.reasons.map((r) => r.code), rationale: verdict.rationale, decisionId: verdict.decisionId, source: node.source, at: now,
      });
      if (nodeChanged) await insertTierChange({ address: addr, from: node.tier, to: verdict.tier, score: verdict.score, block: null, decisionId: verdict.decisionId, at: now, source: node.source });
    }
  } catch (e) {
    console.warn("[events] trustmap regrade failed", addr, (e as Error)?.message);
  }

  return { verdict, from, to: verdict.tier, changed, watches: watches.length, webhooks };
}

/** Why an address matters to us (empty → ignore). */
export async function matchesFor(address: Address, now: number, screenedDays: number): Promise<EventMatch[]> {
  const out: EventMatch[] = [];
  const [watches, node, screened] = await Promise.all([
    activeWatchesFor(address, now).catch(() => []),
    getNode(address).catch(() => null),
    screenedSince(address, now - screenedDays * 86_400).catch(() => false),
  ]);
  if (watches.length) out.push("watched");
  if (node) out.push("trustmap");
  if (screened) out.push("screened");
  return out;
}

/** One event → relevance check → re-screen + webhooks → events_log row. Never throws (errors land in the row). */
export async function handleBlocklistEvent(ev: BlocklistEvent, deps: HandlerDeps = {}): Promise<EventLogEntry> {
  const t0 = Date.now();
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const screenedDays = deps.screenedDays ?? eventsEnv().screenedDays;
  const address = lower(ev.address);
  const matched = await matchesFor(address, now, screenedDays);
  const base = {
    kind: ev.kind, eventName: ev.eventName, address, block: ev.block, txHash: ev.txHash, logIndex: ev.logIndex, simulated: ev.simulated,
    matched, rescreened: false, tierFrom: null as Tier | null, tierTo: null as Tier | null, score: null as number | null,
    decisionId: null as string | null, webhooks: 0, watches: 0, error: null as string | null, latencyMs: null as number | null, handledAt: now,
  };
  let row = base;
  if (matched.length > 0) {
    const reason = `${ev.simulated ? "simulated " : ""}usdc.${ev.kind.toLowerCase()}${ev.txHash ? ` ${ev.txHash}` : ""}`;
    try {
      const r = await rescreenAddressNow(address, reason, deps);
      row = { ...base, rescreened: true, tierFrom: r.from, tierTo: r.to, score: r.verdict.score, decisionId: r.verdict.decisionId, webhooks: r.webhooks, watches: r.watches };
    } catch (e) {
      row = { ...base, error: (e as Error)?.message ?? String(e) };
      console.warn("[events] rescreen failed", address, row.error);
    }
  }
  row.latencyMs = Date.now() - t0;
  const id = await insertEventLog(row);
  return { ...row, id };
}

/** The "blacklist drill": run the handler exactly as if the event had arrived on-chain for `address`. */
export async function simulateBlocklistEvent(address: Address, kind: BlocklistEventKind = "BLOCKLISTED", deps: HandlerDeps = {}): Promise<EventLogEntry> {
  return handleBlocklistEvent(
    { kind, eventName: "Simulated", address: lower(address), block: null, txHash: null, logIndex: null, simulated: true },
    deps,
  );
}

// ─── polling ─────────────────────────────────────────────────────────────────

export interface PollOptions extends HandlerDeps {
  /** scan from this block instead of the stored cursor (+1) */
  fromBlock?: bigint;
  /** blocks per tick (default EVENTS_MAX_BLOCKS = 500) */
  maxBlocks?: number;
  maxLag?: number;
  rpcBudget?: number;
  client?: EventsClient;
  usdc?: Address;
  gate?: Limiter;
  retryBaseMs?: number;
}

export interface PollResult {
  at: number;
  head: number | null;
  fromBlock: number | null;
  toBlock: number | null;
  blocksScanned: number;
  /** blocklist events seen in the window */
  logs: number;
  /** events that touched a watched / graded / recently screened address and were re-screened */
  handled: EventLogEntry[];
  ignored: number;
  duplicates: number;
  webhooks: number;
  /** cursor was behind head by more than maxLag and jumped forward */
  skippedAhead: boolean;
  cursorBlock: number | null;
  rpcCalls: number;
  partial: boolean;
  rateLimited: boolean;
  error: string | null;
  tookMs: number;
}

type RawLog = { eventName?: string; args?: { _account?: Address }; blockNumber: bigint | null; transactionHash: `0x${string}` | null; logIndex: number | null };

interface Ctx { client: EventsClient; gate: Limiter; retryBaseMs: number; budget: number; calls: number; partial: boolean; rateLimited: boolean }
async function rpc<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  return ctx.gate.run(() => rpcRetry(() => { ctx.calls++; return fn(); }, { baseMs: ctx.retryBaseMs }));
}

/** In-order fetch with bisection on range/result-cap errors. `through` = last block fully fetched. */
async function fetchBlocklistLogs(ctx: Ctx, usdc: Address, from: bigint, to: bigint): Promise<{ logs: RawLog[]; through: bigint }> {
  const out: RawLog[] = [];
  let through = from - 1n;
  const queue: [bigint, bigint][] = [[from, to]];
  while (queue.length) {
    const [a, b] = queue.shift()!;
    if (ctx.calls >= ctx.budget) { ctx.partial = true; break; }
    try {
      const logs = (await rpc(ctx, () => ctx.client.getLogs({ address: usdc, events: BLOCKLIST_EVENTS, fromBlock: a, toBlock: b, strict: true }))) as unknown as RawLog[];
      out.push(...logs);
      through = b;
    } catch (err) {
      if (isRangeError(err) && b > a) {
        const mid = a + (b - a) / 2n;
        queue.unshift([a, mid], [mid + 1n, b]);
        continue;
      }
      if (isRateLimited(err)) ctx.rateLimited = true;
      ctx.partial = true;
      break;
    }
  }
  return { logs: out, through };
}

export function kindOf(eventName: string | undefined): BlocklistEventKind {
  return /^un/i.test(eventName ?? "") ? "UNBLOCKLISTED" : "BLOCKLISTED";
}

/** One tick: head → window → getLogs → handle each event → advance cursor. */
export async function pollBlocklistEvents(opts: PollOptions = {}): Promise<PollResult> {
  const t0 = Date.now();
  const env = eventsEnv();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const maxBlocks = BigInt(Math.max(1, opts.maxBlocks ?? env.maxBlocks));
  const maxLag = BigInt(opts.maxLag ?? env.maxLag);
  const usdc = opts.usdc ?? (config().USDC_ADDRESS.toLowerCase() as Address);
  const ctx: Ctx = {
    client: opts.client ?? (arcClient() as EventsClient), gate: opts.gate ?? rpcGate, retryBaseMs: opts.retryBaseMs ?? 250,
    budget: opts.rpcBudget ?? env.rpcBudget, calls: 0, partial: false, rateLimited: false,
  };
  const stored = await getEventsCursor();
  const base: Omit<PollResult, "tookMs"> = {
    at: now, head: null, fromBlock: null, toBlock: null, blocksScanned: 0, logs: 0, handled: [], ignored: 0, duplicates: 0, webhooks: 0,
    skippedAhead: false, cursorBlock: stored, rpcCalls: 0, partial: false, rateLimited: false, error: null,
  };
  const finish = async (r: Omit<PollResult, "tookMs">): Promise<PollResult> => {
    const res: PollResult = { ...r, rpcCalls: ctx.calls, partial: ctx.partial || r.partial, rateLimited: ctx.rateLimited || r.rateLimited, tookMs: Date.now() - t0 };
    const { handled: _h, ...summary } = res;
    await setEventsMeta("last_tick", JSON.stringify({ ...summary, handled: res.handled.length })).catch(() => undefined);
    return res;
  };

  let head: bigint;
  try {
    head = await rpc(ctx, () => ctx.client.getBlockNumber());
  } catch (err) {
    if (isRateLimited(err)) ctx.rateLimited = true;
    return finish({ ...base, partial: true, error: `getBlockNumber: ${(err as Error)?.message ?? err}` });
  }
  let from: bigint;
  let skippedAhead = false;
  if (opts.fromBlock != null) from = opts.fromBlock;
  else if (stored == null) from = head > maxBlocks ? head - maxBlocks + 1n : 0n;
  else {
    from = BigInt(stored) + 1n;
    if (head - from > maxLag) { from = head - maxBlocks + 1n; skippedAhead = true; }
  }
  if (from > head) return finish({ ...base, head: Number(head), skippedAhead });
  const to = from + maxBlocks - 1n < head ? from + maxBlocks - 1n : head;

  const { logs, through } = await fetchBlocklistLogs(ctx, usdc, from, to);
  if (through < from) return finish({ ...base, head: Number(head), fromBlock: Number(from), partial: true, skippedAhead });

  const handled: EventLogEntry[] = [];
  let ignored = 0, duplicates = 0, webhooks = 0;
  const inWindow = logs
    .filter((l) => l.blockNumber == null || (l.blockNumber >= from && l.blockNumber <= through))
    .sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
  for (const l of inWindow) {
    const account = l.args?._account;
    if (!account) continue;
    if (l.transactionHash != null && l.logIndex != null && (await hasHandledLog(l.transactionHash, l.logIndex))) { duplicates++; continue; }
    const entry = await handleBlocklistEvent(
      { kind: kindOf(l.eventName), eventName: l.eventName ?? "Blacklisted", address: lower(account), block: l.blockNumber == null ? null : Number(l.blockNumber), txHash: l.transactionHash, logIndex: l.logIndex, simulated: false },
      { screenFn: opts.screenFn, fetchImpl: opts.fetchImpl, now, screenedDays: opts.screenedDays },
    );
    if (entry.matched.length) { handled.push(entry); webhooks += entry.webhooks; } else ignored++;
  }
  await setEventsCursor(Number(through));
  return finish({
    ...base, head: Number(head), fromBlock: Number(from), toBlock: Number(through), blocksScanned: Number(through - from + 1n),
    logs: inWindow.length, handled, ignored, duplicates, webhooks, skippedAhead, cursorBlock: Number(through),
  });
}
