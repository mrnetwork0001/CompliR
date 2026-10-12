/**
 * GET|POST /api/internal/circle — Circle Developer-Controlled Wallets status for ops dashboards.
 * Protected by `Authorization: Bearer $CRON_SECRET`. Dry-run (no Circle credentials) still answers with mode/reason.
 *
 *   { mode: "local"|"circle", effectiveSigner, circle: {enabled, reason, blockchain, accountType, feeLevel},
 *     attester: 0x… (local key), walletSetId, wallets: [{role, walletId, address, accountType, policy, balances, cliHint}],
 *     gasStation: {...}, hints: [...] }
 *
 * POST with `{ "provision": true }` runs ensureWallets() (creates the wallet set + wallets when live).
 */
import { circleStatus } from "@/lib/circle/client";
import { balances, ensureWallets, listStoredWallets, policyCliHint } from "@/lib/circle/wallets";
import { signerMode } from "@/lib/chain/registryWriter";
import { config } from "@/lib/config";
import { attesterAddress } from "@/lib/pipeline";

async function handle(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid CRON_SECRET" } }, { status: 401 });
  }
  const c = config();
  const status = circleStatus();
  let provision: Awaited<ReturnType<typeof ensureWallets>> | null = null;
  if (req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { provision?: boolean };
    if (body.provision) provision = await ensureWallets();
  }
  const stored = provision?.wallets ?? (await listStoredWallets());
  const wallets = await Promise.all(stored.map(async (w) => {
    const b = status.enabled ? await balances(w.role).catch((e) => ({ status: "error" as const, reason: (e as Error).message, balances: [] })) : { status: "dry-run" as const, reason: status.reason, balances: [] };
    return { role: w.role, walletId: w.walletId, address: w.address, accountType: w.accountType, blockchain: w.blockchain, policy: w.policy, cliHint: policyCliHint(w.address, w.policy), balances: b.balances, balanceStatus: b.status, balanceReason: "reason" in b ? b.reason : undefined };
  }));
  const hints: string[] = [];
  if (!status.enabled) hints.push("Set CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET, then run `node --env-file=.env.local scripts/circle/setup.ts`.");
  if (status.enabled && !stored.length) hints.push("No wallets provisioned yet: POST {\"provision\":true} here or run scripts/circle/setup.ts.");
  const revenue = stored.find((w) => w.role === "revenue");
  if (revenue && c.X402_PAY_TO?.toLowerCase() !== revenue.address) hints.push(`X402_PAY_TO should be the Circle revenue wallet ${revenue.address}.`);
  if (c.SIGNER_MODE === "circle" && signerMode() === "local") hints.push("SIGNER_MODE=circle requested but Circle is not configured → registry writes use the local attester key.");
  return Response.json({
    mode: c.SIGNER_MODE,
    effectiveSigner: signerMode(),
    circle: status,
    attester: c.ATTESTER_PRIVATE_KEY ? attesterAddress() : null,
    registry: c.REGISTRY_ADDRESS ?? null,
    walletSetId: provision?.walletSetId ?? stored[0]?.walletSetId ?? c.CIRCLE_WALLET_SET_ID ?? null,
    wallets,
    provisioned: provision ? { mode: provision.mode, created: provision.created, reason: provision.reason } : undefined,
    gasStation: {
      network: status.blockchain,
      requiresAccountType: "SCA",
      sponsored: status.accountType === "SCA" ? "when an active mainnet Gas Station policy exists for ARC (console.circle.com → Gas Station)" : "no (EOA wallets pay gas from their own USDC balance)",
      fallback: "Arc gas is USDC: without sponsorship the wallet's USDC balance pays gas natively",
    },
    hints,
  });
}
export const GET = handle;
export const POST = handle;
