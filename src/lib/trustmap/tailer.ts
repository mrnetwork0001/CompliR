/**
 * Trust Map tailer: one tick = tail new Arc blocks → aggregate USDC received per recipient (system-emitter
 * Transfer logs, 18 dp → 6 dp) → pick EOAs above TRUSTMAP_MIN_USDC not graded in the regrade window → grade
 * up to TRUSTMAP_MAX_PER_TICK of them with the real pipeline → persist nodes / edges / tier changes / cursor.
 * Every other recipient of the window (and every ungraded counterparty of a graded node) is persisted as an
 * observed *candidate* (trustmap_candidates, bounded retention) so the map shows the real shape of the flow, and
 * graded↔candidate transfers in the window become edges. No extra RPC: candidates come from the logs already fetched.
 *
 * RPC discipline: the tailer's own calls (getBlockNumber + getLogs (+ bisection) + getCode) are capped by
 * TRUSTMAP_RPC_BUDGET (default 24) and go through the shared politeness gate. A rate limit after retries ends
 * the tick early: whatever was fully fetched is processed, the cursor only advances through contiguous blocks,
 * and the result says partial/rateLimited. The pipeline screens have their own budget (arcGraph requestBudget).
 */
import type { PublicClient } from "viem";
import { TRANSFER_EVENT } from "../evidence/arcGraph";
import { ARC_SYSTEM_EMITTER, ARC_USDC_ERC20, evidenceEnv } from "../evidence/env";
import { arcClient } from "../evidence/rpc";
import { isRangeError, isRateLimited, lower, rpcGate, rpcRetry, toUsdc6, type Limiter } from "../evidence/util";
import { screen as pipelineScreen, type ScreenOptions } from "../pipeline";
import type { Address, ScreenRequest, Tier, Verdict } from "../types";
import { trustmapEnv } from "./env";
import {
  addInflow, allCandidateAddresses, allNodeAddresses, cachedIsContract, cachedIsContractMany, countCandidates, countNodes, deleteCandidates, getCursor, getNodes, inflow24h,
  insertEdges, insertTierChange, migrateTrustmap, pruneCandidateEdges, pruneCandidates, pruneInflow, rememberIsContract, setCursor, setLastTick,
  touchNode, upsertCandidates, upsertNode, CANDIDATE_BLOCKS, type CandidateInput, type EdgeInput,
} from "./store";
import type { TickSummary } from "./types";

export type TailClient = Pick<PublicClient, "getBlockNumber" | "getLogs" | "getCode">;
export type ScreenFn = (req: ScreenRequest, opts: ScreenOptions) => Promise<Verdict>;

export interface TailOptions {
  /** scan from this block instead of the stored cursor (+1) */
  fromBlock?: bigint;
  /** blocks per tick (default TRUSTMAP_MAX_BLOCKS = 200) */
  maxBlocks?: number;
  client?: TailClient;
  screenFn?: ScreenFn;
  now?: number;
  minUsdc?: number;
  regradeHours?: number;
  maxPerTick?: number;
  rpcBudget?: number;
  maxLag?: number;
  gate?: Limiter;
  retryBaseMs?: number;
  /** seed the demo nodes when the table is empty (default TRUSTMAP_SEED_DEMO) */
  seedDemo?: boolean;
  emitter?: Address;
  emitterDecimals?: number;
}

export interface GradedEntry {
  address: Address;
  tier: Tier;
  score: number;
  prevTier: Tier | null;
  changed: boolean;
  usdcIn: number;
  decisionId: string;
}

export interface TailResult extends TickSummary {
  head: number;
  skippedContracts: number;
  skippedRecent: number;
  skippedBudget: number;
  gradedNodes: GradedEntry[];
  failures: { address: Address; error: string }[];
  tierChanges: number;
  edges: number;
  /** candidate rows written this tick (new or refreshed) */
  observedNow: number;
  cursorBlock: number | null;
  seeded: boolean;
  tookMs: number;
}

type TransferLog = {
  args: { from?: Address; to?: Address; value?: bigint };
  blockNumber: bigint | null;
  transactionHash: `0x${string}` | null;
  logIndex: number | null;
};

interface Ctx {
  client: TailClient;
  gate: Limiter;
  retryBaseMs: number;
  budget: number;
  calls: number;
  partial: boolean;
  rateLimited: boolean;
}

async function rpc<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  return ctx.gate.run(() =>
    rpcRetry(
      () => {
        ctx.calls++;
        return fn();
      },
      { baseMs: ctx.retryBaseMs },
    ),
  );
}

/** Sequential, in-order fetch with bisection on range/result-cap errors. `through` = last block fully fetched. */
async function fetchTransferLogs(ctx: Ctx, emitter: Address, from: bigint, to: bigint, reserve: number): Promise<{ logs: TransferLog[]; through: bigint }> {
  const out: TransferLog[] = [];
  let through = from - 1n;
  const queue: [bigint, bigint][] = [[from, to]];
  while (queue.length) {
    const [a, b] = queue.shift()!;
    if (ctx.calls + reserve >= ctx.budget) {
      ctx.partial = true;
      break;
    }
    try {
      const logs = (await rpc(ctx, () => ctx.client.getLogs({ address: emitter, event: TRANSFER_EVENT, fromBlock: a, toBlock: b, strict: true }))) as unknown as TransferLog[];
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

export interface Aggregated {
  address: Address;
  micro: bigint;
  usdc: number;
  lastBlock: number;
  transfers: number;
}

/** Sum USDC received per recipient (mints included, self-sends and system addresses excluded). Biggest first. */
export function aggregateRecipients(logs: TransferLog[], decimals: number, exclude: Set<Address> = SYSTEM_ADDRESSES): Aggregated[] {
  const by = new Map<Address, Aggregated>();
  for (const l of logs) {
    const from = l.args.from ? lower(l.args.from) : null;
    const to = l.args.to ? lower(l.args.to) : null;
    const value = l.args.value ?? 0n;
    if (!from || !to || value <= 0n || from === to || exclude.has(to)) continue;
    const micro = decimals >= 6 ? value / 10n ** BigInt(decimals - 6) : value * 10n ** BigInt(6 - decimals);
    const block = Number(l.blockNumber ?? 0n);
    const cur = by.get(to);
    if (cur) {
      cur.micro += micro;
      cur.transfers++;
      if (block > cur.lastBlock) cur.lastBlock = block;
    } else by.set(to, { address: to, micro, usdc: 0, lastBlock: block, transfers: 1 });
  }
  const out = [...by.values()].map((a) => ({ ...a, usdc: Number(a.micro) / 1e6 }));
  out.sort((x, y) => (y.micro > x.micro ? 1 : y.micro < x.micro ? -1 : x.address.localeCompare(y.address)));
  return out;
}

export const SYSTEM_ADDRESSES = new Set<Address>([
  "0x0000000000000000000000000000000000000000",
  ARC_SYSTEM_EMITTER,
  ARC_USDC_ERC20,
]);

async function isContract(ctx: Ctx, address: Address, codeBudget: { left: number }): Promise<boolean | null> {
  const cached = await cachedIsContract(address);
  if (cached !== null) return cached;
  if (codeBudget.left <= 0 || ctx.calls >= ctx.budget) {
    ctx.partial = true;
    return null;
  }
  codeBudget.left--;
  try {
    const code = await rpc(ctx, () => ctx.client.getCode({ address }));
    const yes = !!code && code !== "0x";
    await rememberIsContract(address, yes);
    return yes;
  } catch (err) {
    if (isRateLimited(err)) ctx.rateLimited = true;
    ctx.partial = true;
    return null;
  }
}

export async function tailOnce(opts: TailOptions = {}): Promise<TailResult> {
  const t0 = Date.now();
  const env = trustmapEnv();
  const ev = evidenceEnv();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const minUsdc = opts.minUsdc ?? env.minUsdc;
  const regradeSec = (opts.regradeHours ?? env.regradeHours) * 3600;
  const maxPerTick = opts.maxPerTick ?? env.maxPerTick;
  const maxBlocks = BigInt(Math.max(1, opts.maxBlocks ?? env.maxBlocks));
  const maxLag = BigInt(opts.maxLag ?? env.maxLag);
  const emitter = opts.emitter ?? ev.emitter;
  const decimals = opts.emitterDecimals ?? ev.emitterDecimals;
  const screenFn = opts.screenFn ?? pipelineScreen;
  const ctx: Ctx = {
    client: opts.client ?? (arcClient() as TailClient),
    gate: opts.gate ?? rpcGate,
    retryBaseMs: opts.retryBaseMs ?? 250,
    budget: opts.rpcBudget ?? env.rpcBudget,
    calls: 0,
    partial: false,
    rateLimited: false,
  };

  await migrateTrustmap();
  const seeded = false; // no synthetic seeding: the map only ever shows wallets observed on-chain

  const base: Omit<TailResult, "tookMs"> = {
    at: now, head: 0, fromBlock: null, toBlock: null, blocksScanned: 0, logs: 0, recipients: 0, candidates: 0, graded: 0, failed: 0,
    rpcCalls: 0, partial: false, rateLimited: false, skippedContracts: 0, skippedRecent: 0, skippedBudget: 0, gradedNodes: [], failures: [],
    tierChanges: 0, edges: 0, observedNow: 0, cursorBlock: await getCursor(), seeded, observed: await countCandidates(),
  };
  const finish = async (r: Omit<TailResult, "tookMs">): Promise<TailResult> => {
    const res: TailResult = { ...r, rpcCalls: ctx.calls, partial: ctx.partial || r.partial, rateLimited: ctx.rateLimited || r.rateLimited, tookMs: Date.now() - t0 };
    const { at, fromBlock, toBlock, blocksScanned, logs, recipients, candidates, graded, failed, rpcCalls, partial, rateLimited, observed } = res;
    await setLastTick({ at, fromBlock, toBlock, blocksScanned, logs, recipients, candidates, graded, failed, rpcCalls, partial, rateLimited, observed });
    return res;
  };

  // ── 1. head + window ──────────────────────────────────────────────────────
  let head: bigint;
  try {
    head = await rpc(ctx, () => ctx.client.getBlockNumber());
  } catch (err) {
    if (isRateLimited(err)) ctx.rateLimited = true;
    return finish({ ...base, partial: true, failures: [{ address: "0x" as Address, error: `getBlockNumber: ${(err as Error)?.message ?? err}` }] });
  }
  const stored = base.cursorBlock;
  let from: bigint;
  if (opts.fromBlock != null) from = opts.fromBlock;
  else if (stored == null) from = head > maxBlocks ? head - maxBlocks + 1n : 0n;
  else {
    from = BigInt(stored) + 1n;
    if (head - from > maxLag) from = head - maxBlocks + 1n; // live view: skip ahead rather than crawl history
  }
  if (from > head) return finish({ ...base, head: Number(head) });
  const to = from + maxBlocks - 1n < head ? from + maxBlocks - 1n : head;

  // ── 2. logs (reserve ≥ 2 calls for getCode) ──────────────────────────────
  const { logs, through } = await fetchTransferLogs(ctx, emitter, from, to, 2);
  if (through < from) {
    // nothing fetched → do not move the cursor
    return finish({ ...base, head: Number(head), fromBlock: Number(from), toBlock: null, partial: true });
  }
  const scannedTo = through;
  const inWindow = logs.filter((l) => l.blockNumber == null || (l.blockNumber >= from && l.blockNumber <= scannedTo));
  const recipients = aggregateRecipients(inWindow, decimals);

  // ── 3. inflow bookkeeping + candidate selection ──────────────────────────
  const known = await getNodes(recipients.map((r) => r.address));
  const candidates = recipients.filter((r) => r.usdc >= minUsdc);
  for (const r of candidates) await addInflow(r.address, r.lastBlock, r.usdc, now);
  // nodes that received anything (even below threshold) get their last-seen block bumped
  for (const r of recipients) {
    const n = known.get(r.address);
    if (!n) continue;
    if (r.usdc < minUsdc) await addInflow(r.address, r.lastBlock, r.usdc, now);
    await touchNode(r.address, r.lastBlock, await inflow24h(r.address, now));
  }

  // every remaining call may go to eth_getCode (results are cached, so later ticks spend almost none here)
  const codeBudget = { left: Math.max(0, ctx.budget - ctx.calls) };
  const toGrade: Aggregated[] = [];
  let skippedContracts = 0, skippedRecent = 0, skippedBudget = 0;
  for (const c of candidates) {
    if (toGrade.length >= maxPerTick) break;
    const n = known.get(c.address);
    if (n && n.lastGradedAt > now - regradeSec) {
      skippedRecent++;
      continue;
    }
    const contract = await isContract(ctx, c.address, codeBudget);
    if (contract === null) {
      skippedBudget++;
      continue;
    }
    if (contract) {
      skippedContracts++;
      continue;
    }
    toGrade.push(c);
  }

  // ── 4. grade ──────────────────────────────────────────────────────────────
  const gradedNodes: GradedEntry[] = [];
  const failures: TailResult["failures"] = [];
  const verdicts: Verdict[] = [];
  let tierChanges = 0;
  for (const c of toGrade) {
    const existing = known.get(c.address);
    try {
      const v = await screenFn({ address: c.address, clientId: "trustmap" }, { kind: existing ? "RESCREEN" : "SCREEN", writeOnChain: false });
      verdicts.push(v);
      const usdcIn24h = await inflow24h(c.address, now);
      const { prev, changed } = await upsertNode({
        address: c.address, tier: v.tier, score: v.score, lastSeenBlock: c.lastBlock, usdcIn24h,
        reasonCodes: v.reasons.map((r) => r.code), rationale: v.rationale, decisionId: v.decisionId, source: "chain", at: now,
      });
      if (changed && prev) {
        tierChanges++;
        await insertTierChange({ address: c.address, from: prev.tier, to: v.tier, score: v.score, block: c.lastBlock, decisionId: v.decisionId, at: now });
      }
      gradedNodes.push({ address: c.address, tier: v.tier, score: v.score, prevTier: prev?.tier ?? null, changed, usdcIn: c.usdc, decisionId: v.decisionId });
    } catch (err) {
      failures.push({ address: c.address, error: (err as Error)?.message ?? String(err) });
    }
  }

  // ── 5. observed candidates (no RPC: this window's logs only) ─────────────
  //   every recipient that is not a graded node, plus every ungraded sender that paid a graded node
  const nodeSet = await allNodeAddresses();
  const gradedNow = gradedNodes.map((g) => g.address);
  const cand = new Map<Address, CandidateInput>();
  const bump = (a: Address, block: number, usdcIn: number, usdcOut: number) => {
    const c = cand.get(a);
    if (c) {
      c.usdcIn += usdcIn; c.usdcOut += usdcOut; c.txCount++;
      c.firstSeenBlock = Math.min(c.firstSeenBlock, block); c.lastSeenBlock = Math.max(c.lastSeenBlock, block);
    } else cand.set(a, { address: a, usdcIn, usdcOut, txCount: 1, firstSeenBlock: block, lastSeenBlock: block });
  };
  for (const l of inWindow) {
    if (!l.args.from || !l.args.to || !l.args.value || l.args.value <= 0n) continue;
    const f = lower(l.args.from), t = lower(l.args.to);
    if (f === t) continue;
    const usdc = Number(toUsdc6(l.args.value, decimals));
    const block = Number(l.blockNumber ?? 0n);
    if (!nodeSet.has(t) && !SYSTEM_ADDRESSES.has(t)) bump(t, block, usdc, 0);
    if (!nodeSet.has(f) && !SYSTEM_ADDRESSES.has(f) && nodeSet.has(t)) bump(f, block, 0, usdc);
  }
  const codeKnown = await cachedIsContractMany([...cand.keys()]);
  for (const c of cand.values()) c.isContract = codeKnown.get(c.address) ?? null;
  const observedNow = await upsertCandidates([...cand.values()], now);
  if (gradedNow.length) await deleteCandidates(gradedNow);
  const candSet = await allCandidateAddresses();

  // ── 6. edges: graded↔graded and graded↔candidate transfers in the window + funder paths from the verdicts ──
  const edges: EdgeInput[] = [];
  const onMap = (a: Address) => nodeSet.has(a) || candSet.has(a);
  for (const l of inWindow) {
    if (!l.args.from || !l.args.to || !l.args.value || !l.transactionHash) continue;
    const f = lower(l.args.from), t = lower(l.args.to);
    if (f === t || !onMap(f) || !onMap(t) || !(nodeSet.has(f) || nodeSet.has(t))) continue;
    edges.push({ from: f, to: t, usdc: Number(toUsdc6(l.args.value, decimals)), txHash: l.transactionHash, block: Number(l.blockNumber ?? 0n) });
  }
  for (const v of verdicts) {
    for (const fnd of v.evidence.funders) {
      for (const hop of fnd.path) {
        if (nodeSet.has(hop.from) && nodeSet.has(hop.to) && hop.from !== hop.to) {
          edges.push({ from: hop.from, to: hop.to, usdc: Number(hop.amountUsdc), txHash: hop.txHash, block: 0 });
        }
      }
    }
  }
  const edgeCount = edges.length ? await insertEdges(edges, now) : 0;

  // ── 7. cursor + housekeeping (bounded retention) ─────────────────────────
  await setCursor(Number(scannedTo));
  await pruneInflow(now);
  await pruneCandidates(Number(scannedTo));
  await pruneCandidateEdges(Number(scannedTo) - CANDIDATE_BLOCKS);
  const observed = await countCandidates();

  return finish({
    ...base,
    head: Number(head), fromBlock: Number(from), toBlock: Number(scannedTo), blocksScanned: Number(scannedTo - from + 1n),
    logs: inWindow.length, recipients: recipients.length, candidates: candidates.length, graded: gradedNodes.length, failed: failures.length,
    skippedContracts, skippedRecent, skippedBudget, gradedNodes, failures, tierChanges, edges: edgeCount, observedNow, observed, cursorBlock: Number(scannedTo),
    partial: ctx.partial || scannedTo < to, rateLimited: ctx.rateLimited,
  });
}
