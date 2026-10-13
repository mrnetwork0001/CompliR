/**
 * Source-chain sender checks for an inbound CCTP mint: OpenSanctions (yente CryptoWallet match, same matcher as the
 * subject screen) + the source chain's USDC `isBlacklisted(sender)` over a public RPC. Each check has its own
 * timeout (CCTP_SOURCE_TIMEOUT_MS, 4 s) and degrades to the neutral value; the pair never throws.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { FIAT_TOKEN_ABI } from "../evidence/usdcBlacklist";
import { withTimeout } from "../evidence/util";
import { screenSanctions } from "../evidence/yente";
import { effectiveSanctions } from "../scoring/rules";
import type { Address, SanctionsHit } from "../types";
import { sourceChain, type SourceChain } from "./abi";
import type { SenderChecks } from "./store";

export interface SenderCheckOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** injected for tests: (chain) → client with readContract; default = viem http client on chain.rpc */
  clientFor?: (chain: SourceChain) => Pick<PublicClient, "readContract"> | null;
}

export interface SenderCheck {
  sanctions: SanctionsHit[];
  blacklisted: boolean;
  checks: SenderChecks;
  /** sanctions hits that count under the rules (address matches or confident name matches) or USDC blacklist */
  flagged: boolean;
}

const clients = new Map<number, Pick<PublicClient, "readContract">>();
function defaultClientFor(chain: SourceChain): Pick<PublicClient, "readContract"> | null {
  if (!chain.rpc) return null;
  let c = clients.get(chain.domain);
  if (!c) {
    c = createPublicClient({ transport: http(chain.rpc, { timeout: 4_000, retryCount: 0 }) });
    clients.set(chain.domain, c);
  }
  return c;
}

const FAIL = Symbol("fail");

export async function checkSourceSender(sender: Address, domain: number, opts: SenderCheckOptions = {}): Promise<SenderCheck> {
  const chain = sourceChain(domain);
  const timeoutMs = opts.timeoutMs ?? 4_000;
  const client = chain.usdc ? (opts.clientFor ?? defaultClientFor)(chain) : null;
  const [sanc, bl] = await Promise.all([
    withTimeout<SanctionsHit[] | typeof FAIL>("cctp.sanctions", screenSanctions({ address: sender }, { timeoutMs, fetchImpl: opts.fetchImpl }), timeoutMs, FAIL),
    client && chain.usdc
      ? withTimeout<boolean | typeof FAIL>(
          "cctp.blacklist",
          client.readContract({ address: chain.usdc, abi: FIAT_TOKEN_ABI, functionName: "isBlacklisted", args: [sender] }).then((r) => r === true, () => FAIL),
          timeoutMs,
          FAIL,
        )
      : Promise.resolve<typeof FAIL | "skip">("skip"),
  ]);
  const sanctions = sanc === FAIL ? [] : sanc;
  const blacklisted = bl === true;
  return {
    sanctions,
    blacklisted,
    checks: { sanctions: sanc === FAIL ? "timeout_or_error" : "ok", blacklist: bl === "skip" ? "skipped" : bl === FAIL ? "timeout_or_error" : "ok" },
    flagged: blacklisted || effectiveSanctions(sanctions).length > 0,
  };
}
