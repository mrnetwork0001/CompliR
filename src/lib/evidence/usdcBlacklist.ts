/**
 * Circle FiatToken `isBlacklisted(address)` on Arc's USDC ERC-20 interface (0x3600…0000, proxy → NativeFiatTokenV2).
 * Verified live 2026-10-11: selector 0xfe575a87 returns true on testnet for the documented blocklisted test
 * account 0x70997970C51812dc3A010C7d01b50e0d17dc79C8. Arc's docs call the same list the "USDC blocklist"
 * (events Blocklisted/UnBlocklisted); the view function keeps the FiatToken name. Any revert/error → false.
 */
import { parseAbi, type PublicClient } from "viem";
import type { Address } from "../types";
import { config } from "../config";
import { lower, pMap, rpcGate, rpcRetry } from "./util";

export const FIAT_TOKEN_ABI = parseAbi(["function isBlacklisted(address _account) view returns (bool)"]);

export interface BlacklistOptions {
  client: Pick<PublicClient, "readContract">;
  usdc?: Address;
}

export async function isUsdcBlacklisted(address: Address, opts: BlacklistOptions): Promise<boolean> {
  const usdc = opts.usdc ?? (config().USDC_ADDRESS as Address);
  try {
    const r = await rpcGate.run(() =>
      rpcRetry(() =>
        opts.client.readContract({ address: usdc, abi: FIAT_TOKEN_ABI, functionName: "isBlacklisted", args: [lower(address)] }),
      ),
    );
    return r === true;
  } catch {
    return false;
  }
}

export async function usdcBlacklistMany(addresses: Address[], opts: BlacklistOptions): Promise<Map<Address, boolean>> {
  const uniq = [...new Set(addresses.map(lower))];
  const flags = await pMap(uniq, (a) => isUsdcBlacklisted(a, opts), 3);
  return new Map(uniq.map((a, i) => [a, flags[i]]));
}
