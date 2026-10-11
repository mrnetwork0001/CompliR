/**
 * Mirrors a verdict to AttestationRegistry.sol via `attest(subject, tier, score, decisionHash, issuedAt, validUntil, signature)`.
 * Requires REGISTRY_ADDRESS + ATTESTER_PRIVATE_KEY (the attester signs the EIP-712 message locally). No-op otherwise.
 *
 * Who pays the USDC gas is the signer switch (SIGNER_MODE, docs/CIRCLE_WALLETS.md):
 *   local  (default) — the attester key itself sends the tx (viem).
 *   circle           — the Circle Developer-Controlled `ops` wallet relays it via contract execution (`attest` is
 *                      permissionless: the signature is the authority), Gas Station-sponsored when a policy is active.
 *                      Falls back to `local` when Circle is not configured or the relay fails.
 */
import { createPublicClient, createWalletClient, http, type Abi, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";
import { circleEnabled } from "../circle/client";
import { executeContract } from "../circle/execute";
import { config } from "../config";
import { setRegistryTx } from "../store";
import { TIER_ONCHAIN, type Verdict } from "../types";

import { registryAbi as REGISTRY_ABI } from "../contracts";
async function registryAbi(): Promise<Abi | null> { return REGISTRY_ABI as unknown as Abi; }
export function arcChain(): Chain {
  const id = config().ARC_CHAIN_ID;
  const base = id === arc.id ? arc : id === arcTestnet.id ? arcTestnet : { ...arc, id, name: `arc-${id}` };
  return { ...base, rpcUrls: { default: { http: [config().ARC_RPC_URL] } } };
}
export function registryEnabled(): boolean {
  const c = config();
  return Boolean(c.REGISTRY_ADDRESS && c.ATTESTER_PRIVATE_KEY && !c.COMPLIR_PAUSED);
}

let warnedFallback = false;
/** Effective signer: `circle` only when SIGNER_MODE=circle AND Circle credentials are present; otherwise `local`. */
export function signerMode(): "local" | "circle" {
  if (config().SIGNER_MODE !== "circle") return "local";
  if (circleEnabled()) return "circle";
  if (!warnedFallback) { warnedFallback = true; console.warn("[complir] SIGNER_MODE=circle but Circle is not configured → local signer"); }
  return "local";
}

let lastTx: Promise<unknown> = Promise.resolve(); // serialise nonces
export async function writeAttestationToRegistry(v: Verdict): Promise<`0x${string}` | null> {
  if (!registryEnabled()) return null;
  const abi = await registryAbi();
  if (!abi) return null;
  const c = config();
  const account = privateKeyToAccount(c.ATTESTER_PRIVATE_KEY as `0x${string}`);
  const chain = arcChain();
  const wallet = createWalletClient({ account, chain, transport: http(c.ARC_RPC_URL) });
  const pub = createPublicClient({ chain, transport: http(c.ARC_RPC_URL) });
  const m = v.attestation.typedData.message;
  const args = [m.subject, TIER_ONCHAIN[v.tier], m.score, m.decisionHash, BigInt(m.issuedAt), BigInt(m.validUntil), v.attestation.signature] as const;
  const run = async () => {
    let hash: `0x${string}` | null = null;
    if (signerMode() === "circle") {
      try {
        const r = await executeContract({ role: "ops", address: c.REGISTRY_ADDRESS as `0x${string}`, abi, functionName: "attest", args, refId: `complir:attest:${v.decisionId}` });
        if (r.status === "sent") hash = r.txHash;
      } catch (e) {
        console.warn("[complir] circle relay failed → local signer:", (e as Error)?.message ?? e);
      }
    }
    if (!hash) {
      hash = await wallet.writeContract({ address: c.REGISTRY_ADDRESS as `0x${string}`, abi, functionName: "attest", args });
      await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
    }
    await setRegistryTx(v.decisionId, hash);
    return hash;
  };
  const p = lastTx.then(run, run);
  lastTx = p.catch(() => undefined);
  return p;
}
