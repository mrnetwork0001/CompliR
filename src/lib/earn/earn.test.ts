import "../__tests__/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POLICY, USDC, VAULT_A, VAULT_B, VAULT_ILLIQUID, vault } from "../operator/fixtures";
import { chooseDepositVault, planYield, staticExclusion, type YieldPosition } from "./planner";
import { __resetVaultCache, fetchEarnVaults, normalizeVault } from "./vaults";
import { runYieldOnce, type YieldDeps } from "./sweep";
import { runRevenueYieldOnce, yieldBackend } from "./dispatch";
import type { ExecuteContractInput } from "../circle";

/** Trimmed real row from GET https://api.circle.com/v1/earnKit/vaults/explore?chain=ARC (2026-10-14). */
const API_ROW = {
  address: "0xbeef0016cb2fd5c352ea7ca08a9f54739dfa7298", chain: "ARC", name: "Steakhouse Prime USDC", protocol: "MORPHO", asset: "USDC",
  assetAddress: "0x3600000000000000000000000000000000000000", productType: "vault", asOf: "2026-10-14T13:24:07Z",
  currentApy: 0.03063265707434631, totalDeposits: { raw: "5106077456793", decimals: 6 }, liquidity: { raw: "4942626251195", decimals: 6 }, status: "active", circleGuarded: true,
  manager: { name: "Steakhouse Financial", type: "curator" },
  apyProfile: { current: 0.03063265707434631, native: 0.03063265707434631, d7: 0.024021287728279814, d30: 0.007120154052131183 },
  fee: { performance: 0, management: 0 },
  liquidityProfile: { totalDeposits: { raw: "5106077456793", decimals: 6 }, available: { raw: "4942626251195", decimals: 6 }, totalSupply: { raw: "5103077848993317292364646", decimals: 18 }, status: "active" },
  riskSignals: { circleSentinel: true, warnings: [], earnKitWarnings: [] },
};

describe("normalizeVault / fetchEarnVaults", () => {
  it("maps the Earn API row (illiquid flag, APY, liquidity, sentinel)", () => {
    const v = normalizeVault(API_ROW)!;
    expect(v).toMatchObject({ address: API_ROW.address, name: "Steakhouse Prime USDC", illiquid: false, circleSentinel: true, curator: "Steakhouse Financial" });
    expect(v.apy).toBeCloseTo(0.0306, 4);
    expect(v.availableUsdc).toBeCloseTo(4_942_626.25, 1);
    expect(v.tvlUsdc).toBeCloseTo(5_106_077.46, 1);
    const flagged = normalizeVault({ ...API_ROW, liquidityProfile: { ...API_ROW.liquidityProfile, status: "low_liquidity" } })!;
    expect(flagged.illiquid).toBe(true);
    expect(normalizeVault({ name: "no address" })).toBeNull();
  });
  it("pages through /v1/earnKit/vaults/explore keyless and caches", async () => {
    __resetVaultCache();
    const f = vi.fn(async (url: string) => {
      expect(url).toContain("/v1/earnKit/vaults/explore?chain=ARC");
      return new Response(JSON.stringify({ data: { vaults: [API_ROW], pagination: { totalPages: 1 } } }), { status: 200 });
    });
    const vs = await fetchEarnVaults({ chainId: 5042, fetchImpl: f as unknown as typeof fetch, baseUrl: "https://api.test" });
    expect(vs).toHaveLength(1);
    await fetchEarnVaults({ chainId: 5042, fetchImpl: f as unknown as typeof fetch, baseUrl: "https://api.test" });
    expect(f).toHaveBeenCalledTimes(1);
    await expect(fetchEarnVaults({ chainId: 1, fetchImpl: f as unknown as typeof fetch })).rejects.toThrow(/not supported/);
    const bad = vi.fn(async () => new Response("nope", { status: 503 }));
    await expect(fetchEarnVaults({ chainId: 5042, fetchImpl: bad as unknown as typeof fetch, baseUrl: "https://api.other", fresh: true })).rejects.toThrow(/HTTP 503/);
  });
});

describe("planner - vault choice", () => {
  const pos = (v: { address: `0x${string}`; name: string }, assetsUsdc: number): YieldPosition => ({ vault: v.address, name: v.name, shares: assetsUsdc, assetsUsdc });
  it("excludes vaults Circle flags illiquid even when their APY is best", () => {
    const { vault: v, excluded } = chooseDepositVault([VAULT_ILLIQUID, VAULT_B, VAULT_A], 10, [], POLICY);
    expect(v?.address).toBe(VAULT_A.address);
    expect(excluded.find((e) => e.address === VAULT_ILLIQUID.address)?.reason).toMatch(/illiquid/);
  });
  it("requires available liquidity ≥ 2× (deposit + current position)", () => {
    const thinA = { ...VAULT_A, availableUsdc: 25 };
    // 10 + 5 held = 15 → needs 30 > 25 → A excluded, B wins
    const r = chooseDepositVault([thinA, VAULT_B], 10, [pos(VAULT_A, 5)], POLICY);
    expect(r.vault?.address).toBe(VAULT_B.address);
    expect(r.excluded[0].reason).toMatch(/available 25 < 2× need 15/);
    // exactly 2× passes
    expect(chooseDepositVault([{ ...VAULT_A, availableUsdc: 30 }], 10, [pos(VAULT_A, 5)], POLICY).vault?.address).toBe(VAULT_A.address);
  });
  it("applies the static rules: asset, RED warning, not_whitelisted, sentinel, TVL, APY, pin, contract allowlist", () => {
    expect(staticExclusion(vault({ address: "0x0000000000000000000000000000000000000e01", assetAddress: "0x0000000000000000000000000000000000000eee" }), POLICY)).toMatch(/not USDC/);
    expect(staticExclusion(vault({ address: "0x0000000000000000000000000000000000000e02", warnings: [{ type: "timelock", level: "RED" }] }), POLICY)).toMatch(/RED warning: timelock/);
    expect(staticExclusion(vault({ address: "0x0000000000000000000000000000000000000e03", warnings: [{ type: "not_whitelisted", level: "YELLOW" }] }), POLICY)).toMatch(/not whitelisted/);
    expect(staticExclusion(vault({ address: "0x0000000000000000000000000000000000000e04", circleSentinel: false }), POLICY)).toMatch(/Sentinel/);
    expect(staticExclusion(vault({ address: "0x0000000000000000000000000000000000000e04", circleSentinel: false }), { ...POLICY, requireSentinel: false })).toBeNull();
    expect(staticExclusion(vault({ address: "0x0000000000000000000000000000000000000e05", tvlUsdc: 50_000 }), POLICY)).toMatch(/TVL/);
    expect(staticExclusion(vault({ address: "0x0000000000000000000000000000000000000e06", apy: 0 }), POLICY)).toMatch(/APY/);
    expect(staticExclusion(VAULT_A, { ...POLICY, pinnedVault: VAULT_B.address })).toMatch(/pinned/);
    expect(staticExclusion(VAULT_A, { ...POLICY, contractAllowlist: [USDC, VAULT_B.address] })).toMatch(/allowlist/);
    expect(staticExclusion(VAULT_A, { ...POLICY, contractAllowlist: [USDC, VAULT_A.address.toUpperCase().replace("0X", "0x")] })).toBeNull();
  });
  it("plans DEPOSIT of the excess (capped by max sweep) into the chosen vault; NONE below the float", () => {
    const base = { floatUsdc: 5, minSweepUsdc: 1, maxSweepUsdc: 25, positions: [], vaults: [VAULT_ILLIQUID, VAULT_A, VAULT_B], policy: POLICY };
    expect(planYield({ ...base, balanceUsdc: 12 })).toMatchObject({ action: "DEPOSIT", amount: 7, vault: { address: VAULT_A.address } });
    expect(planYield({ ...base, balanceUsdc: 100 })).toMatchObject({ action: "DEPOSIT", amount: 25 });
    const none = planYield({ ...base, balanceUsdc: 2.02 }); // today's revenue wallet: ~2 USDC vs 5 float
    expect(none.action).toBe("NONE");
    expect(none.reason).toMatch(/no vault to redeem/);
    expect(planYield({ ...base, balanceUsdc: 12, vaults: null })).toMatchObject({ action: "NONE", reason: expect.stringMatching(/never deposit blind/) });
    expect(planYield({ ...base, balanceUsdc: 12, vaults: [VAULT_ILLIQUID] }).action).toBe("NONE");
  });
  it("plans REDEEM from a held vault with ≥ 2× liquidity, else a thin one that still covers it, else nothing", () => {
    const base = { balanceUsdc: 1, floatUsdc: 5, minSweepUsdc: 1, maxSweepUsdc: 25, policy: POLICY };
    const r = planYield({ ...base, positions: [pos(VAULT_A, 10), pos(VAULT_B, 10)], vaults: [VAULT_A, VAULT_B] });
    expect(r).toMatchObject({ action: "REDEEM", amount: 4, vault: { address: VAULT_B.address } }); // lowest APY first
    const thin = planYield({ ...base, positions: [pos(VAULT_A, 10)], vaults: [{ ...VAULT_A, availableUsdc: 5 }] });
    expect(thin).toMatchObject({ action: "REDEEM", amount: 4 });
    expect(thin.reason).toMatch(/thin liquidity/);
    expect(planYield({ ...base, positions: [pos(VAULT_A, 10)], vaults: [{ ...VAULT_A, availableUsdc: 1 }] }).action).toBe("NONE");
    expect(planYield({ ...base, positions: [pos(VAULT_A, 2.5)], vaults: [VAULT_A] })).toMatchObject({ action: "REDEEM", amount: 2.5 });
  });
});

describe("runYieldOnce - dry vs live dispatch", () => {
  const WALLET = "0x00000000000000000000000000000000000000aa";
  const appended: { kind: string; payload: Record<string, unknown> }[] = [];
  const executed: ExecuteContractInput[] = [];
  const deps = (balanceUsdc: number, over: Partial<YieldDeps> = {}): Partial<YieldDeps> => ({
    context: async () => ({ vaults: [VAULT_A, VAULT_B, VAULT_ILLIQUID], policy: POLICY }),
    readState: async () => ({ balanceUsdc, positions: [{ vault: VAULT_A.address, name: VAULT_A.name, shares: 3, assetsUsdc: 3, sharesRaw: "3000000000000000000" }] }),
    execute: async (input) => { executed.push(input); return { status: "sent", role: "revenue", txId: "t" + executed.length, txHash: `0x${String(executed.length).repeat(64)}` as `0x${string}`, state: "CONFIRMED", to: input.address, calldata: "0x", walletId: "w", from: WALLET, feeLevel: "MEDIUM", accountType: "SCA" }; },
    revenueWallet: async () => WALLET,
    preview: async (_v, fn, assets) => (fn === "previewDeposit" ? assets * 10n ** 12n : assets * 10n ** 12n),
    simulateRedeem: async () => {},
    append: async (e) => { appended.push(e as never); return { id: `dec_${appended.length}` } as never; },
    ...over,
  });
  beforeEach(() => {
    appended.length = 0; executed.length = 0;
    process.env.REVENUE_WALLET = WALLET;
    delete process.env.YIELD_MODE; delete process.env.YIELD_FLOAT_USDC; delete process.env.YIELD_BACKEND;
  });

  it("dry: plans, never executes, logs NOOP · YIELD_PLAN", async () => {
    const r = await runYieldOnce({ deps: deps(12) });
    expect(r.mode).toBe("dry");
    expect(r.plan).toMatchObject({ action: "DEPOSIT", amount: 7, vault: { address: VAULT_A.address } });
    expect(r.executed).toBe(false);
    expect(executed).toHaveLength(0);
    expect(appended[0]).toMatchObject({ kind: "NOOP", payload: { type: "YIELD_PLAN", executed: false } });
  });
  it("live deposit: approve USDC → vault.deposit(assets, wallet) through the Circle revenue wallet, OPERATOR · YIELD_SWEEP with tx hashes", async () => {
    process.env.YIELD_MODE = "live";
    const r = await runYieldOnce({ deps: deps(12) });
    expect(r.executed).toBe(true);
    expect(executed.map((e) => [e.role, e.functionName])).toEqual([["revenue", "approve"], ["revenue", "deposit"]]);
    expect(executed[0].address).toBe(USDC);
    expect(executed[0].args).toEqual([VAULT_A.address, 7_000_000n]);
    expect(executed[1]).toMatchObject({ address: VAULT_A.address, args: [7_000_000n, WALLET], policyAmountUsdc: 7 });
    expect(appended[0]).toMatchObject({ kind: "OPERATOR", payload: { type: "YIELD_SWEEP", executed: true, txs: { approve: r.txs.approve, deposit: r.txs.deposit } } });
  });
  it("live redeem: redeem(shares, wallet, wallet) capped at the held shares, OPERATOR · YIELD_REDEEM", async () => {
    process.env.YIELD_MODE = "live";
    const r = await runYieldOnce({ deps: deps(1) }); // shortfall 4, hold 3 → redeem 3
    expect(r.plan).toMatchObject({ action: "REDEEM", amount: 3 });
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ functionName: "redeem", address: VAULT_A.address, args: [3_000_000_000_000_000_000n, WALLET, WALLET] });
    expect(appended[0]).toMatchObject({ kind: "OPERATOR", payload: { type: "YIELD_REDEEM" } });
  });
  it("live but nothing to do (balance below float, nothing held): NONE, no tx", async () => {
    process.env.YIELD_MODE = "live";
    const r = await runYieldOnce({ deps: deps(2.02, { readState: async () => ({ balanceUsdc: 2.02, positions: [] }) }) });
    expect(r.plan.action).toBe("NONE");
    expect(executed).toHaveLength(0);
    expect(appended[0]).toMatchObject({ kind: "NOOP", payload: { type: "YIELD_PLAN" } });
  });
  it("live refuses when the Circle revenue wallet is not the configured REVENUE_WALLET, or the float is unknown", async () => {
    process.env.YIELD_MODE = "live";
    const r = await runYieldOnce({ deps: deps(12, { revenueWallet: async () => "0x00000000000000000000000000000000000000bb" }) });
    expect(r.executed).toBe(false);
    expect(r.error).toMatch(/refusing to move funds/);
    expect(executed).toHaveLength(0);
    const blind = await runYieldOnce({ deps: deps(12, { readState: async () => { throw new Error("rpc down"); } }) });
    expect(blind.error).toMatch(/balance read failed: rpc down/);
    expect(executed).toHaveLength(0);
  });
  it("operator float overrides the env float (cushion + obligations)", async () => {
    expect((await runYieldOnce({ deps: deps(12) })).plan.amount).toBe(7); // env float 5
    const r = await runYieldOnce({ floatUsdc: 11.5, deps: deps(12) });
    expect(r.floatUsdc).toBe(11.5);
    expect(r.plan.action).toBe("NONE"); // excess 0.5 < min sweep 1
  });
  it("dispatch: earn by default, legacy USYC when YIELD_BACKEND=usyc", async () => {
    expect(yieldBackend()).toBe("earn");
    process.env.YIELD_BACKEND = "usyc";
    const runUsyc = vi.fn(async () => ({ mode: "dry" as const, executed: false, wallet: null, balances: null, plan: { action: "NONE" as const, amount: 0, reason: "env " + process.env.USYC_FLOAT_USDC }, txs: {}, decisionId: null }));
    const r = await runRevenueYieldOnce({ floatUsdc: 9, runUsyc });
    expect(r.backend).toBe("usyc");
    expect(r.plan.reason).toBe("env 9");
    expect(process.env.USYC_FLOAT_USDC).toBeUndefined();
  });
});
