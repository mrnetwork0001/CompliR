/**
 * Funder graph from USDC Transfer logs.
 *
 * Arc specifics (docs.arc.io/arc/references/usdc-system-events): a plain native USDC send emits NO log at the
 * ERC-20 address. The system emitter 0xffff…fffE logs a standard Transfer(from,to,value) for every movement
 * (native sends, ERC-20 transfers, mints, burns) at 18 dp. We therefore trace on the emitter, never on both
 * (an ERC-20 transfer() would otherwise be counted twice). Public RPC caps eth_getLogs at 10,000 blocks per
 * request and 2,000 results per query, so we page in ≤9,999-block chunks and bisect a chunk that overflows.
 */
import { parseAbiItem, type Log, type PublicClient } from "viem";
import type { Address, AddressFacts, FunderHop } from "../types";
import { evidenceEnv } from "./env";
import { isRangeError, lower, pMap, rpcGate, rpcRetry, toUsdc6, type Limiter } from "./util";

export const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/** The subset of viem's PublicClient the tracer needs (lets tests pass a plain mock). */
export type GraphClient = Pick<PublicClient, "getLogs" | "getBlock" | "getBlockNumber">;

export interface TraceOptions {
  depth: 1 | 2;
  /** funders kept per traced wallet (hop 1: of the subject; hop 2: of each hop-1 funder). default 10 */
  maxPerHop?: number;
  /** global cap on hop-2 entries (default maxPerHop * 3) */
  maxHop2Total?: number;
  lookbackBlocks?: number;
  chunkBlocks?: number;
  /** parallel getLogs requests (default 4) */
  concurrency?: number;
  client: GraphClient;
  emitter?: Address;
  emitterDecimals?: number;
  /** pin the head (default: client.getBlockNumber()) */
  toBlock?: bigint;
  /** stop starting new hop-2 lookups after this epoch-ms; what was gathered is returned with partial=true */
  deadline?: number;
  /** max getLogs requests for the whole trace (default 24); hop-2 parents beyond it are skipped (partial=true) */
  requestBudget?: number;
  /** backoff base for rate-limit retries (tests shrink it) */
  retryBaseMs?: number;
  /** request gate (default: the shared process-wide rpcGate) */
  gate?: Limiter;
}

export interface FunderEntry {
  hop: 1 | 2;
  path: FunderHop[];
  facts: AddressFacts;
}

export interface TraceResult {
  funders: FunderEntry[];
  /** 0 = hop-1 lookup failed; 1 = hop 1 done (or every hop-2 lookup failed); 2 = hop 2 done */
  depth: 0 | 1 | 2;
  fromBlock: bigint;
  toBlock: bigint;
  /** earliest incoming USDC transfer to the subject inside the window (unix s), if any */
  subjectFirstIncoming: number | null;
  /** number of incoming transfers to the subject inside the window */
  subjectIncomingCount: number;
  requests: number;
  /** some chunk could not be fetched even after bisection */
  partial: boolean;
}

export function emptyFacts(address: Address): AddressFacts {
  return { address: lower(address), firstSeen: null, txCount: 0, usdcBlacklisted: false, protocolBlocklisted: false, sanctions: [] };
}

type TransferLog = Log<bigint, number, false, typeof TRANSFER_EVENT, true> & { blockTimestamp?: bigint | null };

interface Window {
  client: GraphClient;
  emitter: Address;
  decimals: number;
  fromBlock: bigint;
  toBlock: bigint;
  chunk: bigint;
  concurrency: number;
  stats: { requests: number; partial: boolean };
  blockTs: Map<bigint, Promise<number>>;
  gate: Limiter;
  retryBaseMs: number;
}

async function fetchRange(w: Window, to: Address, from: bigint, to_: bigint): Promise<TransferLog[]> {
  try {
    return (await w.gate.run(() =>
      rpcRetry(
        () => {
          w.stats.requests++;
          return w.client.getLogs({
            address: w.emitter,
            event: TRANSFER_EVENT,
            args: { to },
            fromBlock: from,
            toBlock: to_,
            strict: true,
          }) as Promise<TransferLog[]>;
        },
        { baseMs: w.retryBaseMs },
      ),
    )) as TransferLog[];
  } catch (err) {
    // Range / result cap: split and retry down to single-block ranges. Anything else (rate limit after
    // retries, network) → give up on this chunk and flag the trace as partial. Never spiral.
    if (isRangeError(err) && to_ > from) {
      const mid = from + (to_ - from) / 2n;
      const [a, b] = await Promise.all([fetchRange(w, to, from, mid), fetchRange(w, to, mid + 1n, to_)]);
      return [...a, ...b];
    }
    w.stats.partial = true;
    return [];
  }
}

function timestampOf(w: Window, log: TransferLog): Promise<number> {
  if (log.blockTimestamp != null) return Promise.resolve(Number(log.blockTimestamp));
  const bn = log.blockNumber;
  let p = w.blockTs.get(bn);
  if (!p) {
    p = w.client.getBlock({ blockNumber: bn }).then((b) => Number(b.timestamp));
    w.blockTs.set(bn, p);
  }
  return p;
}

/** All USDC transfers INTO `to` within the window, newest first. */
export async function incomingTransfers(w: Window, to: Address): Promise<FunderHop[]> {
  const ranges: [bigint, bigint][] = [];
  for (let start = w.fromBlock; start <= w.toBlock; start += w.chunk) {
    ranges.push([start, start + w.chunk - 1n > w.toBlock ? w.toBlock : start + w.chunk - 1n]);
  }
  const chunks = await pMap(ranges, ([a, b]) => fetchRange(w, to, a, b), w.concurrency);
  const logs = chunks
    .flat()
    .filter((l) => l.args.from && l.args.to && l.args.value != null && l.args.value > 0n && l.args.from.toLowerCase() !== l.args.to.toLowerCase());
  const hops = await pMap(
    logs,
    async (l): Promise<FunderHop> => ({
      from: lower(l.args.from as string),
      to: lower(l.args.to as string),
      txHash: l.transactionHash as `0x${string}`,
      amountUsdc: toUsdc6(l.args.value as bigint, w.decimals),
      timestamp: await timestampOf(w, l),
    }),
    8,
  );
  return hops.sort((a, b) => b.timestamp - a.timestamp || a.txHash.localeCompare(b.txHash));
}

interface Funder {
  address: Address;
  /** representative transfer: the largest (ties → latest) */
  hop: FunderHop;
  totalMicro: bigint;
}

const micro = (s: string) => BigInt(s.replace(".", ""));

/** Group incoming transfers by sender, ignoring mints (0x0) and self-sends; biggest total first. */
export function groupFunders(transfers: FunderHop[], exclude: Set<Address>, max: number): Funder[] {
  const byFrom = new Map<Address, Funder>();
  for (const t of transfers) {
    if (t.from === ZERO_ADDRESS || t.from === t.to || exclude.has(t.from)) continue;
    const cur = byFrom.get(t.from);
    const m = micro(t.amountUsdc);
    if (!cur) byFrom.set(t.from, { address: t.from, hop: t, totalMicro: m });
    else {
      cur.totalMicro += m;
      const curM = micro(cur.hop.amountUsdc);
      if (m > curM || (m === curM && t.timestamp > cur.hop.timestamp)) cur.hop = t;
    }
  }
  return [...byFrom.values()]
    .sort((a, b) => (b.totalMicro > a.totalMicro ? 1 : b.totalMicro < a.totalMicro ? -1 : a.address.localeCompare(b.address)))
    .slice(0, max);
}

/**
 * Hop 1: wallets that sent USDC to `subject`. Hop 2: wallets that sent USDC to those (path = [hop2→hop1, hop1→subject]).
 * `facts` are skeletons (address only); collect.ts enriches them with blacklist / sanctions lookups.
 */
export async function traceFunders(subject: Address, opts: TraceOptions): Promise<TraceResult> {
  const env = evidenceEnv();
  const subj = lower(subject);
  const maxPerHop = opts.maxPerHop ?? 10;
  const maxHop2Total = opts.maxHop2Total ?? maxPerHop * 3;
  const toBlock = opts.toBlock ?? (await opts.client.getBlockNumber());
  const lookback = BigInt(Math.max(1, opts.lookbackBlocks ?? env.lookbackBlocks));
  const fromBlock = toBlock > lookback ? toBlock - lookback + 1n : 0n;
  const w: Window = {
    client: opts.client,
    emitter: opts.emitter ?? env.emitter,
    decimals: opts.emitterDecimals ?? env.emitterDecimals,
    fromBlock,
    toBlock,
    chunk: BigInt(Math.max(1, Math.min(opts.chunkBlocks ?? env.chunkBlocks, 9_999))),
    concurrency: opts.concurrency ?? 4,
    stats: { requests: 0, partial: false },
    blockTs: new Map(),
    gate: opts.gate ?? rpcGate,
    retryBaseMs: opts.retryBaseMs ?? 200,
  };
  const budget = opts.requestBudget ?? 24;
  const chunksPerWallet = Number((toBlock - fromBlock) / w.chunk) + 1;

  const base = { fromBlock, toBlock, requests: 0, partial: false, subjectFirstIncoming: null, subjectIncomingCount: 0 };

  let incoming: FunderHop[];
  try {
    incoming = await incomingTransfers(w, subj);
  } catch {
    return { ...base, funders: [], depth: 0, requests: w.stats.requests, partial: true };
  }
  if (incoming.length === 0 && w.stats.partial) {
    // every chunk failed even after bisection → we learned nothing about hop 1
    return { ...base, funders: [], depth: 0, requests: w.stats.requests, partial: true };
  }
  const hop1 = groupFunders(incoming, new Set([subj]), maxPerHop);
  const funders: FunderEntry[] = hop1.map((f) => ({ hop: 1, path: [f.hop], facts: emptyFacts(f.address) }));
  const subjectFirstIncoming = incoming.length ? Math.min(...incoming.map((t) => t.timestamp)) : null;

  let depth: 0 | 1 | 2 = 1;
  if (opts.depth === 2 && hop1.length > 0) {
    const exclude = new Set<Address>([subj, ...hop1.map((f) => f.address)]);
    // Biggest funders first, one parent at a time (its chunks run in parallel under the gate); stop when the
    // request budget or the deadline is hit - the caller gets hop 1 + whatever hop 2 we managed, partial=true.
    const results: { parent: Funder; hop2: Funder[]; ok: boolean }[] = [];
    for (const parent of hop1) {
      if (w.stats.requests + chunksPerWallet > budget || (opts.deadline && Date.now() >= opts.deadline)) {
        w.stats.partial = true;
        break;
      }
      try {
        const inc = await incomingTransfers(w, parent.address);
        results.push({ parent, hop2: groupFunders(inc, exclude, maxPerHop), ok: true });
      } catch {
        results.push({ parent, hop2: [], ok: false });
      }
    }
    const hop2: FunderEntry[] = [];
    const seen = new Set<Address>();
    for (const r of results) {
      for (const f of r.hop2) {
        if (seen.has(f.address)) continue;
        seen.add(f.address);
        hop2.push({ hop: 2, path: [f.hop, r.parent.hop], facts: emptyFacts(f.address) });
      }
    }
    hop2.sort((a, b) => (micro(b.path[0].amountUsdc) > micro(a.path[0].amountUsdc) ? 1 : -1));
    funders.push(...hop2.slice(0, maxHop2Total));
    depth = results.some((r) => r.ok) ? 2 : 1;
  } else if (opts.depth === 2) {
    depth = 2; // nothing at hop 1 → nothing left to explore
  }

  return {
    ...base,
    funders,
    depth,
    subjectFirstIncoming,
    subjectIncomingCount: incoming.length,
    requests: w.stats.requests,
    partial: w.stats.partial,
  };
}
