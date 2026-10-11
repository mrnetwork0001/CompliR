/**
 * firstSeen / txCount for an address.
 *  - Blockscout (ARC_BLOCKSCOUT_API set): /api/v2/addresses/{a}/counters → transactions_count,
 *    /api?module=account&action=txlist&sort=asc&offset=1 → earliest tx timestamp. Verified live on
 *    https://explorer.testnet.arc.io/api (2026-10-11). explorer.arc.io (mainnet) sits behind a Cloudflare
 *    challenge for non-browser clients, so expect the RPC fallback there until that is relaxed.
 *  - RPC fallback: eth_getTransactionCount (outgoing nonce only) + the earliest incoming USDC transfer the
 *    funder trace saw (`firstSeenHint`). Anything failing → nulls, never throws.
 */
import type { PublicClient } from "viem";
import type { Address } from "../types";
import { config } from "../config";
import { lower, rpcGate, rpcRetry } from "./util";

export interface AddressActivity {
  firstSeen: number | null;
  txCount: number;
  source: "blockscout" | "rpc" | "none";
}

export interface ActivityOptions {
  blockscoutApi?: string | null;
  client?: Pick<PublicClient, "getTransactionCount"> | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** earliest on-chain sighting we already know of (unix s) — used as a floor */
  firstSeenHint?: number | null;
}

/** Accepts ".../api", ".../api/", ".../api/v2" or a bare host → ".../api" */
export function normalizeBlockscoutBase(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  u = u.replace(/\/api\/v2$/i, "/api");
  if (!/\/api$/i.test(u)) u = `${u}/api`;
  return u;
}

async function getJson(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fromBlockscout(address: Address, base: string, fetchImpl: typeof fetch, timeoutMs: number) {
  const [counters, txlist] = await Promise.all([
    getJson(fetchImpl, `${base}/v2/addresses/${address}/counters`, timeoutMs),
    getJson(fetchImpl, `${base}?module=account&action=txlist&address=${address}&sort=asc&page=1&offset=1`, timeoutMs),
  ]);
  const c = counters as { transactions_count?: string | number } | null;
  const txCount = c?.transactions_count != null ? Number(c.transactions_count) : 0;
  const first = (txlist as { result?: { timeStamp?: string }[] } | null)?.result?.[0]?.timeStamp;
  const firstSeen = first != null && Number.isFinite(Number(first)) ? Number(first) : null;
  return { firstSeen, txCount: Number.isFinite(txCount) ? txCount : 0 };
}

export async function fetchActivity(address: Address, opts: ActivityOptions = {}): Promise<AddressActivity> {
  const addr = lower(address);
  const timeoutMs = opts.timeoutMs ?? 4_000;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const hint = opts.firstSeenHint ?? null;
  const minWithHint = (v: number | null) => (v == null ? hint : hint == null ? v : Math.min(v, hint));

  const api = opts.blockscoutApi === undefined ? safeConfigBlockscout() : opts.blockscoutApi;
  if (api && fetchImpl) {
    try {
      const r = await fromBlockscout(addr, normalizeBlockscoutBase(api), fetchImpl, timeoutMs);
      return { firstSeen: minWithHint(r.firstSeen), txCount: r.txCount, source: "blockscout" };
    } catch {
      /* fall through to RPC */
    }
  }
  if (opts.client) {
    try {
      const client = opts.client;
      const nonce = await rpcGate.run(() => rpcRetry(() => client.getTransactionCount({ address: addr })));
      return { firstSeen: hint, txCount: Number(nonce), source: "rpc" };
    } catch {
      /* fall through */
    }
  }
  return { firstSeen: hint, txCount: 0, source: "none" };
}

function safeConfigBlockscout(): string | null {
  try {
    return config().ARC_BLOCKSCOUT_API ?? null;
  } catch {
    return null;
  }
}
