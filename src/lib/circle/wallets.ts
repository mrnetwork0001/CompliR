/**
 * CompliR's two Circle Developer-Controlled Wallets on Arc (docs/CIRCLE_WALLETS.md):
 *
 *   revenue — x402 payTo (what `X402_PAY_TO` should be set to) and the USYC sweep source
 *   ops     — gas-paying relayer for `AttestationRegistry.attest(...)` (permissionless relay of the
 *             locally-signed EIP-712 attestation). SCA by default so Circle Gas Station can sponsor it.
 *
 * `ensureWallets()` is idempotent: ids are persisted in the `circle_wallets` table (and wallets are looked up
 * by `refId` on Circle before any create), so re-running never duplicates wallets.
 *
 * Spending controls: Circle's API-managed *spending policies* (per-tx / daily / weekly caps, allow/blocklists)
 * exist only for **Agent Wallets** (Agent Stack; user-controlled MPC wallets driven by the Circle CLI
 * `circle wallet limit set --chain ARC …`, mainnet only) — there is no REST endpoint to attach one to a
 * developer-controlled wallet. So the policy is stored per role in `circle_wallets.policy` and enforced here
 * (`checkSpend`) before any outbound Circle transaction; Gas Station adds Circle-side gas caps on top.
 */
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { db, migrate } from "../store/db";
import type { Address } from "../types";
import { circleBlockchain, circleClient, circleStatus, type CircleBlockchain } from "./client";

export type WalletRole = "revenue" | "ops";
export const WALLET_ROLES: readonly WalletRole[] = ["revenue", "ops"] as const;

export interface SpendingPolicy {
  /** Max USDC per outbound transfer (0 = no transfers allowed). */
  perTxUsdc: number;
  /** Max USDC per rolling 24h window. */
  dailyUsdc: number;
  /** Contract / recipient allowlist (lower-case). Empty = any target. */
  allowlist: Address[];
  /** How the policy is enforced — app-side here; Circle-side only for Agent Wallets. */
  enforcement: "app" | "circle-agent-wallet";
}

export interface CircleWalletRow {
  role: WalletRole;
  walletId: string;
  address: Address;
  blockchain: CircleBlockchain;
  accountType: "SCA" | "EOA";
  walletSetId: string;
  policy: SpendingPolicy;
  createdAt: number;
  updatedAt: number;
}

export interface EnsureWalletsResult {
  mode: "live" | "dry-run";
  reason?: string;
  blockchain: CircleBlockchain | null;
  walletSetId: string | null;
  wallets: CircleWalletRow[];
  created: WalletRole[];
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS circle_wallets (
     role TEXT NOT NULL, blockchain TEXT NOT NULL, wallet_id TEXT NOT NULL, address TEXT NOT NULL,
     account_type TEXT NOT NULL, wallet_set_id TEXT NOT NULL, policy TEXT NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (role, blockchain))`,
  `CREATE TABLE IF NOT EXISTS circle_spend (
     id TEXT PRIMARY KEY, role TEXT NOT NULL, blockchain TEXT NOT NULL, kind TEXT NOT NULL, amount_usdc REAL NOT NULL,
     target TEXT NOT NULL, tx_id TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS circle_spend_role_time ON circle_spend(role, blockchain, created_at)`,
];
let schemaReady: Promise<void> | null = null;
export function ensureCircleSchema(): Promise<void> {
  if (!schemaReady) schemaReady = (async () => { await migrate(); for (const s of SCHEMA) await db().execute(s); })();
  return schemaReady;
}
/** test helper */
export function __resetCircleSchema() { schemaReady = null; }

const now = () => Math.floor(Date.now() / 1000);
const refIdFor = (role: WalletRole) => `complir:${role}`;

function parseAllowlist(raw: string | undefined): Address[] {
  return (raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{40}$/.test(s)) as Address[];
}

/** Intended policy per role from env (CIRCLE_<ROLE>_POLICY_*). The ops allowlist defaults to the registry. */
export function defaultPolicy(role: WalletRole): SpendingPolicy {
  const c = config();
  if (role === "ops") {
    const allow = parseAllowlist(c.CIRCLE_OPS_POLICY_ALLOWLIST);
    if (!allow.length && c.REGISTRY_ADDRESS) allow.push(c.REGISTRY_ADDRESS.toLowerCase() as Address);
    return { perTxUsdc: c.CIRCLE_OPS_POLICY_PER_TX_USDC, dailyUsdc: c.CIRCLE_OPS_POLICY_DAILY_USDC, allowlist: allow, enforcement: "app" };
  }
  return {
    perTxUsdc: c.CIRCLE_REVENUE_POLICY_PER_TX_USDC,
    dailyUsdc: c.CIRCLE_REVENUE_POLICY_DAILY_USDC,
    allowlist: parseAllowlist(c.CIRCLE_REVENUE_POLICY_ALLOWLIST),
    enforcement: "app",
  };
}

function rowFrom(r: Record<string, unknown>): CircleWalletRow {
  let policy: SpendingPolicy;
  try { policy = JSON.parse(String(r.policy)) as SpendingPolicy; } catch { policy = defaultPolicy(String(r.role) as WalletRole); }
  return {
    role: String(r.role) as WalletRole,
    walletId: String(r.wallet_id),
    address: String(r.address).toLowerCase() as Address,
    blockchain: String(r.blockchain) as CircleBlockchain,
    accountType: String(r.account_type) as "SCA" | "EOA",
    walletSetId: String(r.wallet_set_id),
    policy,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** Persisted wallet for a role on the configured chain (DB only — never calls Circle). */
export async function walletByRole(role: WalletRole): Promise<CircleWalletRow | null> {
  await ensureCircleSchema();
  const bc = circleBlockchain();
  if (!bc) return null;
  const res = await db().execute({ sql: `SELECT * FROM circle_wallets WHERE role = ? AND blockchain = ?`, args: [role, bc] });
  return res.rows[0] ? rowFrom(res.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function listStoredWallets(): Promise<CircleWalletRow[]> {
  await ensureCircleSchema();
  const bc = circleBlockchain();
  if (!bc) return [];
  const res = await db().execute({ sql: `SELECT * FROM circle_wallets WHERE blockchain = ? ORDER BY role`, args: [bc] });
  return res.rows.map((r) => rowFrom(r as unknown as Record<string, unknown>));
}

async function upsertWallet(row: Omit<CircleWalletRow, "createdAt" | "updatedAt">): Promise<CircleWalletRow> {
  await ensureCircleSchema();
  const t = now();
  await db().execute({
    sql: `INSERT INTO circle_wallets (role, blockchain, wallet_id, address, account_type, wallet_set_id, policy, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(role, blockchain) DO UPDATE SET wallet_id = excluded.wallet_id, address = excluded.address,
            account_type = excluded.account_type, wallet_set_id = excluded.wallet_set_id, policy = excluded.policy, updated_at = excluded.updated_at`,
    args: [row.role, row.blockchain, row.walletId, row.address, row.accountType, row.walletSetId, JSON.stringify(row.policy), t, t],
  });
  return { ...row, createdAt: t, updatedAt: t };
}

/** Resolve the wallet set id: env → stored rows → existing set named CIRCLE_WALLET_SET_NAME → create. */
async function resolveWalletSet(stored: CircleWalletRow[]): Promise<{ id: string; created: boolean }> {
  const c = config();
  if (c.CIRCLE_WALLET_SET_ID) return { id: c.CIRCLE_WALLET_SET_ID, created: false };
  if (stored[0]?.walletSetId) return { id: stored[0].walletSetId, created: false };
  const client = circleClient();
  const list = await client.listWalletSets({ pageSize: 50 });
  const byName = (list.data?.walletSets ?? []).find((ws) => (ws as { name?: string }).name === c.CIRCLE_WALLET_SET_NAME);
  if (byName) return { id: byName.id, created: false };
  const created = await client.createWalletSet({ name: c.CIRCLE_WALLET_SET_NAME, idempotencyKey: randomUUID() });
  const id = created.data?.walletSet?.id;
  if (!id) throw new Error("circle: createWalletSet returned no id");
  return { id, created: true };
}

/**
 * Create-or-fetch the "complir" wallet set and the `revenue` + `ops` wallets on the configured Arc network.
 * Dry-run (no credentials) returns whatever is already stored and a reason — it never throws for config reasons.
 */
export async function ensureWallets(): Promise<EnsureWalletsResult> {
  const status = circleStatus();
  const stored = await listStoredWallets();
  if (!status.enabled) {
    return { mode: "dry-run", reason: status.reason, blockchain: status.blockchain, walletSetId: stored[0]?.walletSetId ?? config().CIRCLE_WALLET_SET_ID ?? null, wallets: stored, created: [] };
  }
  const bc = status.blockchain!;
  const missing = WALLET_ROLES.filter((r) => !stored.some((w) => w.role === r));
  if (!missing.length) return { mode: "live", blockchain: bc, walletSetId: stored[0].walletSetId, wallets: stored, created: [] };

  const client = circleClient();
  const set = await resolveWalletSet(stored);
  const wallets = [...stored];
  const created: WalletRole[] = [];
  for (const role of missing) {
    const refId = refIdFor(role);
    const existing = await client.listWallets({ walletSetId: set.id, blockchain: bc, refId, pageSize: 10 });
    let w = (existing.data?.wallets ?? []).find((x) => x.refId === refId && x.blockchain === bc);
    if (!w) {
      const res = await client.createWallets({
        walletSetId: set.id,
        blockchains: [bc],
        count: 1,
        accountType: status.accountType,
        metadata: [{ name: `complir ${role}`, refId }],
        idempotencyKey: randomUUID(),
      });
      w = res.data?.wallets?.[0];
      if (!w) throw new Error(`circle: createWallets(${role}) returned no wallet`);
      created.push(role);
    }
    wallets.push(await upsertWallet({
      role, walletId: w.id, address: w.address.toLowerCase() as Address, blockchain: bc,
      accountType: (w.accountType as "SCA" | "EOA") ?? status.accountType, walletSetId: set.id, policy: defaultPolicy(role),
    }));
  }
  wallets.sort((a, b) => a.role.localeCompare(b.role));
  return { mode: "live", blockchain: bc, walletSetId: set.id, wallets, created };
}

export interface TokenBalance { symbol: string; amount: string; isNative: boolean; tokenAddress: string | null; decimals: number | null }
export interface BalancesResult {
  status: "ok" | "dry-run" | "not-provisioned";
  reason?: string;
  role: WalletRole;
  address: Address | null;
  balances: TokenBalance[];
}

/** Live token balances from Circle for a role (USDC is the native gas asset on Arc, so it shows as `isNative`). */
export async function balances(role: WalletRole): Promise<BalancesResult> {
  const status = circleStatus();
  const w = await walletByRole(role);
  if (!status.enabled) return { status: "dry-run", reason: status.reason, role, address: w?.address ?? null, balances: [] };
  if (!w) return { status: "not-provisioned", reason: "run `node --env-file=.env.local scripts/circle/setup.ts`", role, address: null, balances: [] };
  const res = await circleClient().getWalletTokenBalance({ id: w.walletId, includeAll: true });
  const list = (res.data?.tokenBalances ?? []).map((b) => ({
    symbol: b.token.symbol ?? (b.token.isNative ? "native" : "?"),
    amount: b.amount,
    isNative: Boolean(b.token.isNative),
    tokenAddress: b.token.tokenAddress ?? null,
    decimals: b.token.decimals ?? null,
  }));
  return { status: "ok", role, address: w.address, balances: list };
}

/**
 * Store the intended spending policy for a role. Enforcement is app-side (`checkSpend`) — Circle has no API to attach
 * per-wallet caps to a developer-controlled wallet; the equivalent Circle-side control exists for Agent Wallets via
 * `circle wallet limit set --chain ARC --policy-type stablecoin --per-tx … --daily …` (returned as `cliHint`).
 */
export async function applySpendingPolicy(role: WalletRole, policy: Partial<Omit<SpendingPolicy, "enforcement">>): Promise<{ policy: SpendingPolicy; stored: boolean; cliHint: string }> {
  const merged: SpendingPolicy = { ...defaultPolicy(role), ...policy, allowlist: (policy.allowlist ?? defaultPolicy(role).allowlist).map((a) => a.toLowerCase() as Address), enforcement: "app" };
  if (merged.perTxUsdc > merged.dailyUsdc) throw new Error("policy: perTxUsdc must be ≤ dailyUsdc");
  const w = await walletByRole(role);
  if (w) await db().execute({ sql: `UPDATE circle_wallets SET policy = ?, updated_at = ? WHERE role = ? AND blockchain = ?`, args: [JSON.stringify(merged), now(), role, w.blockchain] });
  return { policy: merged, stored: Boolean(w), cliHint: policyCliHint(w?.address ?? "<wallet-address>", merged) };
}

export function policyCliHint(address: string, p: SpendingPolicy): string {
  const parts = [`circle wallet limit set --address ${address} --chain ARC --policy-type stablecoin --per-tx ${p.perTxUsdc} --daily ${p.dailyUsdc}`];
  if (p.allowlist.length) parts.push(`circle wallet limit set --address ${address} --chain ARC --rule-type contract-allowlist --targets "[${p.allowlist.join(",")}]"`);
  return parts.join("\n");
}

export async function policyFor(role: WalletRole): Promise<SpendingPolicy> {
  return (await walletByRole(role))?.policy ?? defaultPolicy(role);
}

export class SpendingPolicyError extends Error {
  constructor(public readonly role: WalletRole, public readonly rule: "allowlist" | "per-tx" | "daily", message: string) {
    super(message);
    this.name = "SpendingPolicyError";
  }
}

/** Rolling-24h USDC already spent by a role (app-side ledger of Circle-initiated outbound value). */
export async function spentLast24h(role: WalletRole): Promise<number> {
  await ensureCircleSchema();
  const bc = circleBlockchain();
  if (!bc) return 0;
  const res = await db().execute({ sql: `SELECT COALESCE(SUM(amount_usdc), 0) AS s FROM circle_spend WHERE role = ? AND blockchain = ? AND created_at > ?`, args: [role, bc, now() - 86_400] });
  return Number((res.rows[0] as unknown as { s: unknown })?.s ?? 0);
}

/** Throws SpendingPolicyError when a target/amount violates the stored policy. amountUsdc=0 for pure contract calls. */
export async function checkSpend(role: WalletRole, input: { target: string; amountUsdc: number }): Promise<SpendingPolicy> {
  const p = await policyFor(role);
  const target = input.target.toLowerCase();
  if (p.allowlist.length && !p.allowlist.includes(target as Address)) throw new SpendingPolicyError(role, "allowlist", `${role}: target ${target} not in allowlist`);
  if (input.amountUsdc > 0) {
    if (input.amountUsdc > p.perTxUsdc) throw new SpendingPolicyError(role, "per-tx", `${role}: ${input.amountUsdc} USDC exceeds per-tx cap ${p.perTxUsdc}`);
    const spent = await spentLast24h(role);
    if (spent + input.amountUsdc > p.dailyUsdc) throw new SpendingPolicyError(role, "daily", `${role}: ${spent} + ${input.amountUsdc} USDC exceeds daily cap ${p.dailyUsdc}`);
  }
  return p;
}

export async function recordSpend(role: WalletRole, input: { kind: "transfer" | "contract"; target: string; amountUsdc: number; txId?: string }): Promise<void> {
  await ensureCircleSchema();
  const bc = circleBlockchain();
  if (!bc) return;
  await db().execute({
    sql: `INSERT INTO circle_spend (id, role, blockchain, kind, amount_usdc, target, tx_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [randomUUID(), role, bc, input.kind, input.amountUsdc, input.target.toLowerCase(), input.txId ?? null, now()],
  });
}
