/**
 * Pure yield planner: how much to move (same float rule as the USYC sweep) and *where* (which Earn vault).
 *
 * Deposit vault choice - among Circle Earn vaults on Arc, keep only those that:
 *   - take USDC (assetAddress == USDC_ADDRESS),
 *   - are NOT flagged illiquid by Circle (liquidityProfile.status "low_liquidity"),
 *   - carry no RED protocol warning (e.g. "timelock") and are not "not_whitelisted" (unlisted on Morpho),
 *   - are covered by Circle Sentinel (when requireSentinel, the default),
 *   - have TVL ≥ minTvlUsdc and a positive APY,
 *   - are in the revenue wallet's contract allowlist (when that allowlist is non-empty),
 *   - have available liquidity ≥ liquidityMultiple × (deposit + what we already hold there) - i.e. we could redeem
 *     the whole position twice over right now;
 * then take the best current APY (ties → larger TVL).
 * Redeem vault choice - among vaults we hold: available ≥ liquidityMultiple × amount preferred (lowest APY first),
 * else any vault whose available liquidity covers the amount; otherwise nothing moves.
 */
import { planSweep } from "../usyc/sweep";
import type { YieldVault } from "./vaults";

export interface YieldPolicy {
  usdcAddress: string;
  minTvlUsdc: number;
  requireSentinel: boolean;
  /** available liquidity must be ≥ this × the redeem need (default 2) */
  liquidityMultiple: number;
  /** YIELD_VAULT: only this vault may receive deposits */
  pinnedVault: string | null;
  /** revenue-wallet contract allowlist; empty = no restriction */
  contractAllowlist: string[];
}
export interface YieldPosition {
  vault: `0x${string}`;
  name: string;
  /** vault shares (18 dp on Morpho V2) as a decimal number */
  shares: number;
  /** shares valued in USDC (convertToAssets) */
  assetsUsdc: number;
}
export interface ExcludedVault { address: string; name: string; reason: string }
export type YieldAction = "DEPOSIT" | "REDEEM" | "NONE";
export interface YieldPlan {
  action: YieldAction;
  amount: number;
  vault: { address: `0x${string}`; name: string; apy: number; availableUsdc: number } | null;
  reason: string;
  /** vaults considered and why they were not chosen (deposit side) */
  excluded: ExcludedVault[];
}
export interface YieldPlanInput {
  balanceUsdc: number;
  floatUsdc: number;
  minSweepUsdc: number;
  /** cap per deposit (keeps a sweep under the revenue wallet's per-tx policy) */
  maxSweepUsdc: number;
  positions: YieldPosition[];
  /** null = Earn metadata unavailable → never deposit blind */
  vaults: YieldVault[] | null;
  policy: YieldPolicy;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

/** Static (amount-independent) reason a vault may not receive a deposit, or null when it may. */
export function staticExclusion(v: YieldVault, p: YieldPolicy): string | null {
  if (p.pinnedVault && lc(v.address) !== lc(p.pinnedVault)) return "not the pinned YIELD_VAULT";
  if (lc(v.assetAddress) !== lc(p.usdcAddress)) return `asset ${v.asset || v.assetAddress} is not USDC`;
  if (v.illiquid) return "flagged illiquid by Circle Earn (low_liquidity)";
  const red = v.warnings.filter((w) => w.level === "RED").map((w) => w.type);
  if (red.length) return `RED warning: ${red.join(", ")}`;
  if (v.warnings.some((w) => w.type === "not_whitelisted")) return "not whitelisted on Morpho";
  if (p.requireSentinel && !v.circleSentinel) return "not covered by Circle Sentinel";
  if (!(v.tvlUsdc >= p.minTvlUsdc)) return `TVL ${Math.round(v.tvlUsdc)} < ${p.minTvlUsdc} USDC`;
  if (!(v.apy > 0)) return "APY ≤ 0";
  if (p.contractAllowlist.length && !p.contractAllowlist.map(lc).includes(lc(v.address))) return "not in the revenue wallet contract allowlist";
  return null;
}

/** Choose the deposit vault for `amount`. */
export function chooseDepositVault(vaults: YieldVault[], amount: number, positions: YieldPosition[], p: YieldPolicy): { vault: YieldVault | null; excluded: ExcludedVault[] } {
  const excluded: ExcludedVault[] = [];
  const ok: YieldVault[] = [];
  for (const v of vaults) {
    if (lc(v.assetAddress) !== lc(p.usdcAddress)) continue; // EURC etc. are not candidates at all
    const why = staticExclusion(v, p);
    if (why) { excluded.push({ address: v.address, name: v.name, reason: why }); continue; }
    const held = positions.find((x) => lc(x.vault) === lc(v.address))?.assetsUsdc ?? 0;
    const need = r6(amount + held);
    if (!(v.availableUsdc >= p.liquidityMultiple * need)) { excluded.push({ address: v.address, name: v.name, reason: `available ${r6(v.availableUsdc)} < ${p.liquidityMultiple}× need ${need}` }); continue; }
    ok.push(v);
  }
  ok.sort((a, b) => b.apy - a.apy || b.tvlUsdc - a.tvlUsdc);
  return { vault: ok[0] ?? null, excluded };
}

/** Choose the vault to redeem `amount` from. Returns the capped amount too. */
export function chooseRedeemVault(vaults: YieldVault[] | null, amount: number, positions: YieldPosition[], p: YieldPolicy): { position: YieldPosition; vault: YieldVault | null; amount: number; note: string } | null {
  const held = positions.filter((x) => x.assetsUsdc > 0);
  const meta = (a: string) => vaults?.find((v) => lc(v.address) === lc(a)) ?? null;
  const rows = held.map((pos) => ({ pos, v: meta(pos.vault), amt: r6(Math.min(amount, pos.assetsUsdc)) }));
  const strong = rows.filter((r) => r.v && r.v.availableUsdc >= p.liquidityMultiple * r.amt).sort((a, b) => (a.v!.apy - b.v!.apy) || (b.pos.assetsUsdc - a.pos.assetsUsdc));
  if (strong[0]) return { position: strong[0].pos, vault: strong[0].v, amount: strong[0].amt, note: `available ${r6(strong[0].v!.availableUsdc)} ≥ ${p.liquidityMultiple}× ${strong[0].amt}` };
  const weak = rows.filter((r) => r.v && r.v.availableUsdc >= r.amt).sort((a, b) => b.v!.availableUsdc - a.v!.availableUsdc);
  if (weak[0]) return { position: weak[0].pos, vault: weak[0].v, amount: weak[0].amt, note: `thin liquidity: available ${r6(weak[0].v!.availableUsdc)} covers ${weak[0].amt} but not ${p.liquidityMultiple}×` };
  return null;
}

export function planYield(input: YieldPlanInput): YieldPlan {
  const held = r6(input.positions.reduce((s, x) => s + Math.max(0, x.assetsUsdc || 0), 0));
  const base = planSweep({ balanceUsdc: input.balanceUsdc, floatUsdc: input.floatUsdc, minSweepUsdc: input.minSweepUsdc, usycUsdc: held });
  const none = (reason: string, excluded: ExcludedVault[] = []): YieldPlan => ({ action: "NONE", amount: 0, vault: null, reason, excluded });
  if (base.action === "NONE") return none(base.reason.replace(/USYC/g, "vault"));

  if (base.action === "DEPOSIT") {
    if (!input.vaults) return none("Earn vault metadata unavailable - never deposit blind");
    const max = Math.max(0, Number(input.maxSweepUsdc) || 0);
    const amount = max > 0 ? r6(Math.min(base.amount, max)) : base.amount;
    if (amount < input.minSweepUsdc || amount <= 0) return none(`capped amount ${amount} below min sweep ${input.minSweepUsdc}`);
    const { vault, excluded } = chooseDepositVault(input.vaults, amount, input.positions, input.policy);
    if (!vault) return none(`no eligible Earn vault for ${amount} USDC (${excluded.length} excluded)`, excluded);
    const capped = amount < base.amount ? ` (capped at max sweep ${max})` : "";
    return {
      action: "DEPOSIT", amount, excluded,
      vault: { address: vault.address, name: vault.name, apy: vault.apy, availableUsdc: vault.availableUsdc },
      reason: `${base.reason}${capped}; best eligible vault ${vault.name} ${vault.address} at ${pct(vault.apy)} APY, available ${Math.round(vault.availableUsdc)} USDC ≥ ${input.policy.liquidityMultiple}× need`,
    };
  }

  // REDEEM
  const pick = chooseRedeemVault(input.vaults, base.amount, input.positions, input.policy);
  if (!pick) return none(`shortfall ${base.amount} USDC but no held vault has liquidity to cover it${input.vaults ? "" : " (Earn metadata unavailable)"}`);
  if (pick.amount < input.minSweepUsdc || pick.amount <= 0) return none(`redeemable ${pick.amount} below min sweep ${input.minSweepUsdc}`);
  return {
    action: "REDEEM", amount: pick.amount, excluded: [],
    vault: { address: pick.position.vault, name: pick.vault?.name ?? pick.position.name, apy: pick.vault?.apy ?? 0, availableUsdc: pick.vault?.availableUsdc ?? 0 },
    reason: `balance ${r6(input.balanceUsdc)} USDC is below float ${input.floatUsdc}; redeem ${pick.amount} from ${pick.vault?.name ?? pick.position.name} (${pick.note})`,
  };
}
