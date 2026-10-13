/**
 * agentFacts(address): is the subject the owner (or the agentWallet) of an ERC-8004 agent on Arc, and what do the
 * Reputation / Validation registries say about that agent? Read-only, bounded for the evidence collector's 4 s guard:
 *   1. index lookup (erc8004_agents) ‖ IdentityRegistry.balanceOf(subject)
 *   2. confirm the lowest agentId live: ownerOf / getAgentWallet / tokenURI
 *   3. ReputationRegistry: getClients → getSummary + readAllFeedback (≤ ERC8004_MAX_READS clients)
 *      ValidationRegistry: getAgentValidations → getValidationStatus per hash (≤ ERC8004_MAX_READS)
 * Any failure degrades to the neutral value; the function never throws. A `balanceOf > 0` with no index row still
 * reports registered=true (agentId null, indexPending=true) and kicks a background index sync.
 */
import type { PublicClient } from "viem";
import { pMap, rpcGate, rpcRetry } from "../evidence/util";
import type { Address, AgentSignal } from "../types";
import { IDENTITY_ABI, REPUTATION_ABI, VALIDATION_ABI } from "./abi";
import { erc8004Env } from "./env";
import { syncAgentIndex, type IndexClient } from "./indexer";
import { agentsFor, getCursor, type AgentRow } from "./store";

export type ReadClient = Pick<PublicClient, "readContract">;

export interface AgentFactsOptions {
  client: ReadClient;
  /** injected for tests; default erc8004_agents lookup */
  lookup?: (address: Address) => Promise<AgentRow[]>;
  /** kick a background index sync when the cursor is stale (default true outside tests) */
  lazySync?: boolean;
  now?: number;
}

/** Tags on feedback / validation that we read as a dispute even when the value is not negative. */
export const DISPUTE_TAG = /dispute|fraud|scam|malicious|rug|stolen|sanction/i;
/** A validation response below this (0–100) counts as a failed validation. */
export const VALIDATION_FAIL_BELOW = 50;

export async function agentFacts(address: Address, opts: AgentFactsOptions): Promise<AgentSignal | null> {
  const env = erc8004Env();
  const subject = address.toLowerCase() as Address;
  const lookup = opts.lookup ?? agentsFor;
  const read = <T>(fn: () => Promise<T>): Promise<T | null> => rpcGate.run(() => rpcRetry(fn)).catch(() => null);
  const identity = (functionName: "ownerOf" | "getAgentWallet" | "tokenURI" | "balanceOf", args: readonly [bigint] | readonly [Address]) =>
    read(() => opts.client.readContract({ address: env.identity, abi: IDENTITY_ABI, functionName, args } as never));

  const [rows, balance] = await Promise.all([
    lookup(subject).catch(() => [] as AgentRow[]),
    identity("balanceOf", [subject]) as Promise<bigint | null>,
  ]);
  const registries = { chainId: env.chainId, identity: env.identity, reputation: env.reputation, validation: env.validation };

  if (opts.lazySync !== false) void maybeSync(opts.client as IndexClient, env.indexStaleBlocks);

  // Confirm candidates live (index may lag a transfer); first confirmed wins.
  let agent: { id: bigint; owner: Address; wallet: Address | null; uri: string | null; role: "owner" | "wallet" } | null = null;
  for (const row of rows.slice(0, 3)) {
    const id = BigInt(row.agentId);
    const [owner, wallet, uri] = await Promise.all([
      identity("ownerOf", [id]) as Promise<Address | null>,
      identity("getAgentWallet", [id]) as Promise<Address | null>,
      identity("tokenURI", [id]) as Promise<string | null>,
    ]);
    const o = (owner ?? row.owner).toLowerCase() as Address;
    const w = ((wallet ?? row.wallet) ?? null) as Address | null;
    const wl = w ? (w.toLowerCase() as Address) : null;
    if (o === subject) agent = { id, owner: o, wallet: wl, uri: uri ?? row.agentUri, role: "owner" };
    else if (wl === subject) agent = { id, owner: o, wallet: wl, uri: uri ?? row.agentUri, role: "wallet" };
    if (agent) break;
  }

  if (!agent) {
    const owns = balance != null && balance > 0n;
    if (!owns) return null;
    return {
      registered: true, indexPending: true, role: "owner", agentId: null, agentURI: null, owner: subject, agentWallet: null,
      registries, reputation: null, validations: null, disputes: [],
    };
  }

  const selfAddrs = new Set<Address>([agent.owner, ...(agent.wallet ? [agent.wallet] : [])]);
  const [reputation, validations] = await Promise.all([
    readReputation(agent.id, opts.client, env.reputation, env.maxReads, read),
    readValidations(agent.id, opts.client, env.validation, env.maxReads, selfAddrs, read),
  ]);
  const disputes: AgentSignal["disputes"] = [];
  if (reputation) for (const f of reputation.negativeItems) disputes.push({ source: "feedback", client: f.client, value: f.value, tag: f.tag });
  if (validations) for (const v of validations.failedItems) disputes.push({ source: "validation", validator: v.validator, response: v.response, tag: v.tag, requestHash: v.requestHash });

  return {
    registered: true,
    role: agent.role,
    agentId: agent.id.toString(),
    agentURI: agent.uri,
    owner: agent.owner,
    agentWallet: agent.wallet,
    registries,
    reputation: reputation ? { count: reputation.count, avg: reputation.avg, negative: reputation.negativeItems.length, clients: reputation.clients } : null,
    validations: validations ? { count: validations.count, responded: validations.responded, nonSelf: validations.nonSelf, failed: validations.failedItems.length, validators: validations.validators, last: validations.last } : null,
    disputes,
  };
}

type Reader = <T>(fn: () => Promise<T>) => Promise<T | null>;

async function readReputation(id: bigint, client: ReadClient, reg: Address, max: number, read: Reader) {
  const clients = (await read(() => client.readContract({ address: reg, abi: REPUTATION_ABI, functionName: "getClients", args: [id] }))) as readonly Address[] | null;
  if (clients == null) return null;
  if (clients.length === 0) return { count: 0, avg: null, clients: 0, negativeItems: [] as { client: Address; value: number; tag: string }[] };
  const subset = clients.slice(0, max) as Address[];
  const [summary, all] = await Promise.all([
    read(() => client.readContract({ address: reg, abi: REPUTATION_ABI, functionName: "getSummary", args: [id, subset, "", ""] })),
    read(() => client.readContract({ address: reg, abi: REPUTATION_ABI, functionName: "readAllFeedback", args: [id, subset, "", "", false] })),
  ]);
  let count = 0;
  let avg: number | null = null;
  if (summary) {
    const [c, v, dec] = summary as readonly [bigint, bigint, number];
    count = Number(c);
    avg = count > 0 ? Number(v) / 10 ** Number(dec) : null;
  }
  const negativeItems: { client: Address; value: number; tag: string }[] = [];
  if (all) {
    const [cl, , values, decs, t1, t2] = all as readonly [readonly Address[], readonly bigint[], readonly bigint[], readonly number[], readonly string[], readonly string[], readonly boolean[]];
    if (!summary) count = cl.length;
    for (let i = 0; i < cl.length; i++) {
      const value = Number(values[i]) / 10 ** Number(decs[i] ?? 0);
      const tag = [t1[i], t2[i]].filter(Boolean).join("/");
      if (value < 0 || DISPUTE_TAG.test(tag)) negativeItems.push({ client: cl[i].toLowerCase() as Address, value, tag });
    }
  }
  return { count, avg, clients: clients.length, negativeItems };
}

async function readValidations(id: bigint, client: ReadClient, reg: Address, max: number, self: Set<Address>, read: Reader) {
  const hashes = (await read(() => client.readContract({ address: reg, abi: VALIDATION_ABI, functionName: "getAgentValidations", args: [id] }))) as readonly `0x${string}`[] | null;
  if (hashes == null) return null;
  const statuses = await pMap(hashes.slice(0, max), async (h) => {
    const s = await read(() => client.readContract({ address: reg, abi: VALIDATION_ABI, functionName: "getValidationStatus", args: [h] }));
    if (!s) return null;
    const [validator, , response, , tag, lastUpdate] = s as readonly [Address, bigint, number, `0x${string}`, string, bigint];
    return { requestHash: h, validator: validator.toLowerCase() as Address, response: Number(response), tag, at: Number(lastUpdate) };
  }, 3);
  const items = statuses.filter((s): s is NonNullable<typeof s> => s != null);
  const responded = items.filter((s) => s.at > 0);
  const nonSelf = responded.filter((s) => !self.has(s.validator));
  const failedItems = responded.filter((s) => s.response < VALIDATION_FAIL_BELOW || DISPUTE_TAG.test(s.tag));
  const last = responded.reduce<(typeof items)[number] | null>((m, s) => (m == null || s.at > m.at ? s : m), null);
  return {
    count: hashes.length,
    responded: responded.length,
    nonSelf: nonSelf.length,
    validators: [...new Set(responded.map((s) => s.validator))].sort(),
    failedItems,
    last: last ? { requestHash: last.requestHash, validator: last.validator, response: last.response, tag: last.tag, at: last.at } : null,
  };
}

let lastSyncCheck = 0;
async function maybeSync(client: IndexClient, staleBlocks: number) {
  const t = Date.now();
  if (t - lastSyncCheck < 60_000) return; // one check per minute per process
  lastSyncCheck = t;
  try {
    const [cursor, head] = await Promise.all([getCursor(), client.getBlockNumber()]);
    if (cursor == null || Number(head) - cursor > staleBlocks) await syncAgentIndex({ client, maxChunks: 10 });
  } catch {
    /* background only */
  }
}
