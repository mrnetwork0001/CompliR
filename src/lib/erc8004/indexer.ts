/**
 * address → agentId index for the ERC-8004 IdentityRegistry (a plain ERC-721: no enumeration, no owner→token lookup).
 * Tails Registered / Transfer / MetadataSet logs from ERC8004_FROM_BLOCK (or the stored cursor) in ≤9_999-block chunks
 * (public Arc RPC cap, -32012) and refreshes owner / agentWallet / tokenURI live for every agentId touched.
 * Idempotent; the cursor advances only through contiguously fetched blocks. Called from the CCTP tick and lazily
 * (fire-and-forget) from agentFacts() when the cursor is stale.
 */
import type { PublicClient } from "viem";
import { arcClient } from "../evidence/rpc";
import { isRangeError, pMap, rpcGate, rpcRetry } from "../evidence/util";
import type { Address } from "../types";
import { IDENTITY_ABI } from "./abi";
import { erc8004Env } from "./env";
import { getCursor, setCursor, setMeta, upsertAgent } from "./store";

export type IndexClient = Pick<PublicClient, "getBlockNumber" | "getLogs" | "readContract">;

export interface SyncOptions {
  client?: IndexClient;
  /** override the number of 9_999-block chunks per call */
  maxChunks?: number;
  now?: number;
}
export interface SyncResult {
  fromBlock: number;
  toBlock: number;
  head: number;
  agentsTouched: number;
  partial: boolean;
  error: string | null;
}

const CHUNK = 9_999n;
let inFlight: Promise<SyncResult> | null = null;

/** Serialised in-process: a second concurrent call joins the running sync. */
export function syncAgentIndex(opts: SyncOptions = {}): Promise<SyncResult> {
  if (inFlight) return inFlight;
  inFlight = run(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function run(opts: SyncOptions): Promise<SyncResult> {
  const env = erc8004Env();
  const client = opts.client ?? (arcClient() as IndexClient);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const head = Number(await rpcGate.run(() => rpcRetry(() => client.getBlockNumber())));
  const cursor = await getCursor();
  const from = cursor == null ? env.fromBlock : cursor + 1;
  const maxChunks = opts.maxChunks ?? env.indexChunks;
  const res: SyncResult = { fromBlock: from, toBlock: from - 1, head, agentsTouched: 0, partial: false, error: null };
  if (from > head) return res;

  const touched = new Map<bigint, { owner?: Address; uri?: string; block?: number }>();
  let a = BigInt(from);
  let chunks = 0;
  try {
    while (a <= BigInt(head)) {
      if (chunks >= maxChunks) { res.partial = true; break; }
      let b = a + CHUNK - 1n;
      if (b > BigInt(head)) b = BigInt(head);
      let logs;
      try {
        logs = await rpcGate.run(() => rpcRetry(() => client.getLogs({ address: env.identity, events: IDENTITY_ABI.filter((x) => x.type === "event"), fromBlock: a, toBlock: b })));
      } catch (err) {
        if (isRangeError(err) && b > a) { b = a + (b - a) / 2n; continue; }
        throw err;
      }
      for (const l of logs) {
        const args = l.args as Record<string, unknown>;
        if (l.eventName === "Registered") {
          const id = args.agentId as bigint;
          touched.set(id, { ...touched.get(id), owner: (args.owner as string).toLowerCase() as Address, uri: args.agentURI as string, block: Number(l.blockNumber) });
        } else if (l.eventName === "Transfer") {
          const id = args.tokenId as bigint;
          touched.set(id, { ...touched.get(id), owner: (args.to as string).toLowerCase() as Address });
        } else if (l.eventName === "URIUpdated") {
          const id = args.agentId as bigint;
          touched.set(id, { ...touched.get(id), uri: args.newURI as string });
        } else if (l.eventName === "MetadataSet") {
          const id = args.agentId as bigint;
          if (!touched.has(id)) touched.set(id, {});
        }
      }
      res.toBlock = Number(b);
      chunks++;
      a = b + 1n;
    }
  } catch (err) {
    res.partial = true;
    res.error = (err as Error)?.message ?? String(err);
  }

  // Refresh owner / wallet live for every touched agent (the log replay above may be stale for transferred tokens).
  const ids = [...touched.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  await pMap(ids, async (id) => {
    const t = touched.get(id)!;
    const [owner, wallet] = await Promise.all([
      readSafe(() => client.readContract({ address: env.identity, abi: IDENTITY_ABI, functionName: "ownerOf", args: [id] })),
      readSafe(() => client.readContract({ address: env.identity, abi: IDENTITY_ABI, functionName: "getAgentWallet", args: [id] })),
    ]);
    const finalOwner = (owner ?? t.owner) as Address | undefined;
    if (!finalOwner) return;
    await upsertAgent({ agentId: id, owner: finalOwner, wallet: (wallet as Address | null) ?? null, agentUri: t.uri ?? null, registeredBlock: t.block ?? null, now });
    res.agentsTouched++;
  }, 3);

  if (res.toBlock >= res.fromBlock) await setCursor(res.toBlock);
  await setMeta("last_sync", JSON.stringify({ at: now, ...res }));
  return res;
}

async function readSafe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await rpcGate.run(() => rpcRetry(fn));
  } catch {
    return null;
  }
}
