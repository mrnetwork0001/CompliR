/**
 * viem public client for Arc, picked by ARC_CHAIN_ID (viem 2.57 ships both chains).
 *
 * Network facts verified live on 2026-10-11 (see .env.example for sources):
 *   mainnet 5042     rpc https://rpc.mainnet.arc.io   explorer https://explorer.arc.io
 *   testnet 5042002  rpc https://rpc.testnet.arc.io   explorer https://explorer.testnet.arc.io (Blockscout)
 *   USDC ERC-20 interface on both: 0x3600000000000000000000000000000000000000 (NativeFiatTokenV2, 6 dp)
 *   native USDC Transfer logs (18 dp, EIP-7708) come from the system emitter 0xffff…fffE, NOT from the ERC-20 address
 *   public eth_getLogs: ≤10,000-block range (error -32012) and ≤2,000 results per query (error -32602)
 */
import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";
import { arc, arcTestnet } from "viem/chains";
import { config } from "../config";

export const GETLOGS_MAX_RANGE = 10_000;
export const GETLOGS_MAX_RESULTS = 2_000;

/** viem's `arc` / `arcTestnet` definition for the id, with our RPC URL as the default; custom chain otherwise. */
export function chainFor(chainId: number, rpcUrl: string): Chain {
  const base = chainId === arc.id ? arc : chainId === arcTestnet.id ? arcTestnet : null;
  if (base) return { ...base, rpcUrls: { ...base.rpcUrls, default: { http: [rpcUrl] } } };
  return defineChain({
    id: chainId,
    name: `Arc (custom ${chainId})`,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

let cached: PublicClient | null = null;

/** Shared public client. Built lazily from config(); http transport with a 4 s timeout and 1 retry. */
export function arcClient(): PublicClient {
  if (cached) return cached;
  const c = config();
  cached = createPublicClient({
    chain: chainFor(c.ARC_CHAIN_ID, c.ARC_RPC_URL),
    transport: http(c.ARC_RPC_URL, { timeout: 4_000, retryCount: 1 }),
  }) as PublicClient;
  return cached;
}

/** test helper */
export function __resetArcClient() {
  cached = null;
}
