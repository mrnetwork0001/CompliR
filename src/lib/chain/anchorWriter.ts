/**
 * Anchors the decision log's Merkle root on Arc via AttestationRegistry.anchorRoot(root, fromSeq, toSeq).
 * Runs when at least ANCHOR_EVERY_N decisions are unanchored and the registry + attester key are configured.
 *
 * `anchorRoot` is `onlyAttester` (not a permissionless relay like `attest`), so under SIGNER_MODE=circle the Circle
 * `ops` wallet can only anchor if it *is* the registry attester (owner called `setAttester(opsWallet)`; needs an EOA
 * wallet — see docs/CIRCLE_WALLETS.md). We read `attester()` on-chain and pick: Circle when it matches, else the
 * local attester key. `via` in the result says which one ran.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { executeContract } from "../circle/execute";
import { walletByRole } from "../circle/wallets";
import { config } from "../config";
import { registryAbi } from "../contracts";
import { anchorPending } from "../ledger";
import { unanchoredDecisions } from "../store";
import { arcChain, registryEnabled, signerMode } from "./registryWriter";

export interface AnchorResult { anchored: boolean; count: number; tx?: `0x${string}`; reason?: string; via?: "local" | "circle" }

export async function anchorIfDue(): Promise<AnchorResult> {
  const pending = await unanchoredDecisions();
  const c = config();
  if (pending.length < c.ANCHOR_EVERY_N) return { anchored: false, count: pending.length, reason: `below ANCHOR_EVERY_N=${c.ANCHOR_EVERY_N}` };
  if (!registryEnabled()) return { anchored: false, count: pending.length, reason: "registry not configured (REGISTRY_ADDRESS/ATTESTER_PRIVATE_KEY)" };
  const account = privateKeyToAccount(c.ATTESTER_PRIVATE_KEY as `0x${string}`);
  const chain = arcChain();
  const wallet = createWalletClient({ account, chain, transport: http(c.ARC_RPC_URL) });
  const pub = createPublicClient({ chain, transport: http(c.ARC_RPC_URL) });
  const registry = c.REGISTRY_ADDRESS as `0x${string}`;

  let via: "local" | "circle" = "local";
  if (signerMode() === "circle") {
    try {
      const ops = await walletByRole("ops");
      const attester = (await pub.readContract({ address: registry, abi: registryAbi, functionName: "attester" })) as string;
      if (ops && attester.toLowerCase() === ops.address) via = "circle";
      else console.warn(`[complir] anchorRoot is onlyAttester; attester=${attester} ≠ circle ops wallet → local key anchors`);
    } catch (e) {
      console.warn("[complir] could not resolve attester for circle anchoring → local:", (e as Error)?.message ?? e);
    }
  }

  const res = await anchorPending(async (root, fromSeq, toSeq) => {
    const args = [root, BigInt(fromSeq), BigInt(toSeq)] as const;
    if (via === "circle") {
      const r = await executeContract({ role: "ops", address: registry, abi: registryAbi, functionName: "anchorRoot", args, refId: `complir:anchor:${fromSeq}-${toSeq}` });
      if (r.status === "sent") return r.txHash;
      via = "local"; // dry-run → fall through to the local key
    }
    const hash = await wallet.writeContract({ address: registry, abi: registryAbi, functionName: "anchorRoot", args });
    await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
    return hash;
  });
  return res ? { anchored: true, count: res.count, tx: res.tx, via } : { anchored: false, count: 0, reason: "nothing pending" };
}
