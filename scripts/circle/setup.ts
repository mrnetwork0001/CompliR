/**
 * One-shot Circle Developer-Controlled Wallets setup for CompliR (docs/CIRCLE_WALLETS.md).
 *
 *   node --env-file=.env.local scripts/circle/setup.ts                    # provision (or print console steps when no key)
 *   node scripts/circle/setup.ts --generate-secret                        # print a fresh 32-byte entity secret
 *   node --env-file=.env.local scripts/circle/setup.ts --register         # register the entity secret ciphertext (ONE-TIME; saves the recovery file)
 *   node --env-file=.env.local scripts/circle/setup.ts --balances         # also print live balances
 *
 * Env: CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, ARC_CHAIN_ID (5042→ARC, 5042002→ARC-TESTNET), CIRCLE_WALLET_SET_ID (optional),
 *      CIRCLE_WALLET_SET_NAME (default complir), CIRCLE_ACCOUNT_TYPE (SCA default; EOA to make a wallet the registry attester),
 *      REGISTRY_ADDRESS, CIRCLE_OPS_POLICY_* / CIRCLE_REVENUE_POLICY_* (printed as the policy to apply).
 *
 * Self-contained on purpose (only the SDK + node builtins) so plain `node` can run it; the app re-discovers the same
 * wallets by refId (`complir:revenue`, `complir:ops`) through `ensureWallets()`, so running this twice is harmless.
 *
 * Sources: https://developers.circle.com/wallets/dev-controlled/create-your-first-wallet ·
 *          https://developers.circle.com/wallets/supported-blockchains (ARC / ARC-TESTNET) ·
 *          https://developers.circle.com/wallets/gas-station/policy-management (mainnet sponsorship needs an active policy)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { generateEntitySecret, initiateDeveloperControlledWalletsClient, registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";

const args = new Set(process.argv.slice(2));
const env = process.env;
const chainId = Number(env.ARC_CHAIN_ID ?? 5042);
const blockchain = chainId === 5042 ? "ARC" : chainId === 5042002 ? "ARC-TESTNET" : null;
const accountType = (env.CIRCLE_ACCOUNT_TYPE ?? "SCA") as "SCA" | "EOA";
const setName = env.CIRCLE_WALLET_SET_NAME ?? "complir";
const ROLES = ["revenue", "ops"] as const;

const policy = {
  ops: { perTx: env.CIRCLE_OPS_POLICY_PER_TX_USDC ?? "1", daily: env.CIRCLE_OPS_POLICY_DAILY_USDC ?? "10", allow: env.CIRCLE_OPS_POLICY_ALLOWLIST ?? env.REGISTRY_ADDRESS ?? "" },
  revenue: { perTx: env.CIRCLE_REVENUE_POLICY_PER_TX_USDC ?? "25", daily: env.CIRCLE_REVENUE_POLICY_DAILY_USDC ?? "100", allow: env.CIRCLE_REVENUE_POLICY_ALLOWLIST ?? "" },
};

function printConsoleSteps() {
  console.log(`
CompliR × Circle - DRY-RUN (no CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET). Nothing was created. To go live:

 1. https://console.circle.com → create an account → API Keys → "Create a key" (Wallets access). Put it in CIRCLE_API_KEY.
    Toggle the console to MAINNET for Arc mainnet (5042); testnet keys only see ARC-TESTNET.
 2. Entity secret:   node scripts/circle/setup.ts --generate-secret     → CIRCLE_ENTITY_SECRET (64 hex chars; Circle never stores it)
 3. Register it ONCE: node --env-file=.env.local scripts/circle/setup.ts --register
    (alternative: console → Wallets → Configurator → paste the ciphertext). Save the recovery file it writes - it is the only
    way to reset the secret and can only be downloaded during registration.
 4. Provision:       node --env-file=.env.local scripts/circle/setup.ts
    → prints CIRCLE_WALLET_SET_ID, X402_PAY_TO (= revenue wallet) and the ops wallet address.
 5. Gas sponsorship (SCA wallets only): console → Gas Station → mainnet → New policy → blockchain ${blockchain ?? "ARC"},
    max spend/day + per-tx in USD → Create → Activate. Add a card (sponsored gas is billed in USD + 5%).
    Without a policy the wallet's own USDC balance pays gas (USDC is Arc's native gas asset) - fund ops with a few USDC.
 6. Set SIGNER_MODE=circle so registry writes relay through the ops wallet. Keep ATTESTER_PRIVATE_KEY (it signs EIP-712 off-chain).
`);
}

async function main() {
  if (args.has("--generate-secret")) {
    console.log("New entity secret (store it as CIRCLE_ENTITY_SECRET; never commit it):");
    generateEntitySecret(); // prints to stdout
    return;
  }
  if (!env.CIRCLE_API_KEY || !env.CIRCLE_ENTITY_SECRET) { printConsoleSteps(); return; }
  if (!/^[0-9a-fA-F]{64}$/.test(env.CIRCLE_ENTITY_SECRET)) throw new Error("CIRCLE_ENTITY_SECRET must be 64 hex chars (32 bytes) - run --generate-secret");
  if (!blockchain) throw new Error(`ARC_CHAIN_ID=${chainId} is not a Circle-supported Arc network (5042 → ARC, 5042002 → ARC-TESTNET)`);

  if (args.has("--register")) {
    mkdirSync(".data", { recursive: true });
    const res = await registerEntitySecretCiphertext({ apiKey: env.CIRCLE_API_KEY, entitySecret: env.CIRCLE_ENTITY_SECRET, ...(env.CIRCLE_BASE_URL ? { baseUrl: env.CIRCLE_BASE_URL } : {}) });
    const out = `.data/circle-recovery-${Date.now()}.dat`;
    writeFileSync(out, res.data?.recoveryFile ?? "");
    console.log(`Entity secret registered. Recovery file written to ${out} - move it somewhere safe (it cannot be downloaded again).`);
  }

  const client = initiateDeveloperControlledWalletsClient({ apiKey: env.CIRCLE_API_KEY, entitySecret: env.CIRCLE_ENTITY_SECRET, ...(env.CIRCLE_BASE_URL ? { baseUrl: env.CIRCLE_BASE_URL } : {}) });

  // Wallet set: env id → existing set with our name → create.
  let walletSetId = env.CIRCLE_WALLET_SET_ID;
  if (!walletSetId) {
    const sets = await client.listWalletSets({ pageSize: 50 });
    walletSetId = (sets.data?.walletSets ?? []).find((s) => (s as { name?: string }).name === setName)?.id;
  }
  if (!walletSetId) {
    const created = await client.createWalletSet({ name: setName, idempotencyKey: randomUUID() });
    walletSetId = created.data?.walletSet?.id;
    if (!walletSetId) throw new Error("createWalletSet returned no id");
    console.log(`Created wallet set "${setName}" → ${walletSetId}`);
  }

  const wallets: Record<string, { id: string; address: string; accountType: string }> = {};
  for (const role of ROLES) {
    const refId = `complir:${role}`;
    const found = await client.listWallets({ walletSetId, blockchain, refId, pageSize: 10 });
    let w = (found.data?.wallets ?? []).find((x) => x.refId === refId && x.blockchain === blockchain);
    if (!w) {
      const res = await client.createWallets({ walletSetId, blockchains: [blockchain], count: 1, accountType, metadata: [{ name: `complir ${role}`, refId }], idempotencyKey: randomUUID() });
      w = res.data?.wallets?.[0];
      if (!w) throw new Error(`createWallets(${role}) returned no wallet`);
      console.log(`Created ${role} wallet ${w.address} (${w.accountType}) on ${blockchain}`);
    } else {
      console.log(`Found ${role} wallet ${w.address} (${w.accountType}) on ${blockchain}`);
    }
    wallets[role] = { id: w.id, address: w.address, accountType: w.accountType };
    if (args.has("--balances")) {
      const b = await client.getWalletTokenBalance({ id: w.id, includeAll: true });
      for (const t of b.data?.tokenBalances ?? []) console.log(`   ${t.token.symbol ?? "?"}${t.token.isNative ? " (native gas)" : ""}: ${t.amount}`);
    }
  }

  console.log(`
# ── paste into .env.local ──
CIRCLE_WALLET_SET_ID=${walletSetId}
X402_PAY_TO=${wallets.revenue.address}
REVENUE_WALLET=${wallets.revenue.address}
OWN_WALLETS=${wallets.revenue.address},${wallets.ops.address}
SIGNER_MODE=circle
# ops (relayer) wallet: ${wallets.ops.address}  (${wallets.ops.accountType}; walletId ${wallets.ops.id})
# revenue wallet:       ${wallets.revenue.address}  (${wallets.revenue.accountType}; walletId ${wallets.revenue.id})

# ── spending policy (app-enforced by src/lib/circle/wallets.ts; stored per wallet, shown by GET /api/internal/circle) ──
# ops:     per-tx ${policy.ops.perTx} USDC · daily ${policy.ops.daily} USDC · contract allowlist ${policy.ops.allow || "(any - set REGISTRY_ADDRESS or CIRCLE_OPS_POLICY_ALLOWLIST)"}
# revenue: per-tx ${policy.revenue.perTx} USDC · daily ${policy.revenue.daily} USDC · recipient allowlist ${policy.revenue.allow || "(any)"}
# Circle-side equivalents exist only for Agent Wallets (Circle CLI, mainnet): e.g.
#   circle wallet limit set --address ${wallets.ops.address} --chain ARC --policy-type stablecoin --per-tx ${policy.ops.perTx} --daily ${policy.ops.daily}

# ── gas ──
# ${accountType === "SCA" ? "SCA wallets: activate a mainnet Gas Station policy for " + blockchain + " (console → Gas Station) to sponsor gas; otherwise" : "EOA wallets are never sponsored;"}
# the wallet's own USDC pays gas natively on Arc - send a few USDC to the ops wallet.
`);
}

main().catch((e) => { console.error("setup failed:", e?.response?.data ?? e?.message ?? e); process.exit(1); });
