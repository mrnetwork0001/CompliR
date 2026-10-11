/**
 * Arc protocol-level blocklist.
 *
 * STATUS (docs.arc.io, checked 2026-10-11): no separate protocol/chain-level denylist contract is documented.
 * The only chain-level denylist is the USDC contract's own blocklist (0x3600…0000, events
 * `Blocklisted(address)` / `UnBlocklisted(address)`), which Arc enforces beyond the token itself: the RPC node
 * rejects txs from blocklisted senders pre-mempool, execution rejects them pre-execution, and the CallFrom
 * precompile (Memo / Multicall3From routing) checks the original sender. See
 * https://docs.arc.io/integrate/infrastructure/compliance and /arc/references/contract-addresses (no
 * blocklist contract listed). That signal is already covered by usdcBlacklist.ts.
 *
 * This module is the hook for a future dedicated contract: set PROTOCOL_BLOCKLIST_ADDRESS and it will call
 * `isBlocklisted(address)` (then `isBlacklisted(address)` as a fallback ABI). Unset → always false.
 */
import { parseAbi, type PublicClient } from "viem";
import type { Address } from "../types";
import { config } from "../config";
import { lower, pMap, rpcGate, rpcRetry } from "./util";

export const PROTOCOL_BLOCKLIST_ABI = parseAbi([
  "function isBlocklisted(address account) view returns (bool)",
  "function isBlacklisted(address account) view returns (bool)",
]);

export interface ProtocolBlocklistOptions {
  client?: Pick<PublicClient, "readContract"> | null;
  /** explicit contract; `undefined` → config().PROTOCOL_BLOCKLIST_ADDRESS; `null` → disabled */
  contract?: Address | null;
}

export function protocolBlocklistAddress(): Address | null {
  try {
    return (config().PROTOCOL_BLOCKLIST_ADDRESS as Address | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function isProtocolBlocklisted(address: Address, opts: ProtocolBlocklistOptions = {}): Promise<boolean> {
  const contract = opts.contract === undefined ? protocolBlocklistAddress() : opts.contract;
  if (!contract || !opts.client) return false;
  for (const functionName of ["isBlocklisted", "isBlacklisted"] as const) {
    try {
      const client = opts.client;
      const r = await rpcGate.run(() =>
        rpcRetry(() => client.readContract({ address: contract, abi: PROTOCOL_BLOCKLIST_ABI, functionName, args: [lower(address)] })),
      );
      return r === true;
    } catch {
      /* try next ABI */
    }
  }
  return false;
}

export async function protocolBlocklistMany(addresses: Address[], opts: ProtocolBlocklistOptions = {}): Promise<Map<Address, boolean>> {
  const uniq = [...new Set(addresses.map(lower))];
  const contract = opts.contract === undefined ? protocolBlocklistAddress() : opts.contract;
  if (!contract || !opts.client) return new Map(uniq.map((a) => [a, false]));
  const flags = await pMap(uniq, (a) => isProtocolBlocklisted(a, { ...opts, contract }), 3);
  return new Map(uniq.map((a, i) => [a, flags[i]]));
}
