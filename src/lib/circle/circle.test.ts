import "../__tests__/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Mocked Circle SDK - every client method is a vi.fn the tests program per case. */
const sdk = vi.hoisted(() => ({
  listWalletSets: vi.fn(),
  createWalletSet: vi.fn(),
  listWallets: vi.fn(),
  createWallets: vi.fn(),
  getWalletTokenBalance: vi.fn(),
  createContractExecutionTransaction: vi.fn(),
  createTransaction: vi.fn(),
  getTransaction: vi.fn(),
  signTypedData: vi.fn(),
}));
vi.mock("@circle-fin/developer-controlled-wallets", () => ({ initiateDeveloperControlledWalletsClient: () => sdk }));

import { signerMode, writeAttestationToRegistry } from "../chain/registryWriter";
import { __resetConfig } from "../config";
import { registryAbi } from "../contracts";
import { __resetDb } from "../store/db";
import type { Verdict } from "../types";
import { __resetCircleClient, circleBlockchainFor, circleStatus } from "./client";
import { executeContract, signTypedDataWithCircle, waitForTxHash } from "./execute";
import { SpendingPolicyError, __resetCircleSchema, applySpendingPolicy, balances, checkSpend, ensureWallets, recordSpend, walletByRole } from "./wallets";

const REGISTRY = "0x1111111111111111111111111111111111111111";
const OPS_ADDR = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const REV_ADDR = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";

function live() {
  process.env.CIRCLE_API_KEY = "TEST_API_KEY:0123456789abcdef:0123456789abcdef";
  process.env.CIRCLE_ENTITY_SECRET = "ab".repeat(32);
}
function dry() {
  delete process.env.CIRCLE_API_KEY;
  delete process.env.CIRCLE_ENTITY_SECRET;
}
/** Program the SDK so a fresh account provisions set "ws1" + two wallets. */
function programProvisioning() {
  sdk.listWalletSets.mockResolvedValue({ data: { walletSets: [] } });
  sdk.createWalletSet.mockResolvedValue({ data: { walletSet: { id: "ws1" } } });
  sdk.listWallets.mockResolvedValue({ data: { wallets: [] } });
  sdk.createWallets.mockImplementation(async (input: { metadata: { refId: string }[] }) => {
    const refId = input.metadata[0].refId;
    const role = refId.split(":")[1];
    return { data: { wallets: [{ id: `w-${role}`, address: role === "ops" ? OPS_ADDR : REV_ADDR, blockchain: "ARC", accountType: "SCA", refId }] } };
  });
}

beforeEach(() => {
  dry();
  delete process.env.SIGNER_MODE;
  delete process.env.REGISTRY_ADDRESS;
  delete process.env.ATTESTER_PRIVATE_KEY;
  delete process.env.CIRCLE_WALLET_SET_ID;
  delete process.env.CIRCLE_OPS_POLICY_ALLOWLIST;
  __resetConfig(); __resetDb(); __resetCircleSchema(); __resetCircleClient();
  vi.clearAllMocks();
});

describe("circle client / dry-run", () => {
  it("maps Arc chain ids to Circle blockchain ids", () => {
    expect(circleBlockchainFor(5042)).toBe("ARC");
    expect(circleBlockchainFor(5042002)).toBe("ARC-TESTNET");
    expect(circleBlockchainFor(1)).toBeNull();
  });
  it("reports a clear dry-run status without credentials", async () => {
    const s = circleStatus();
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/CIRCLE_API_KEY \+ CIRCLE_ENTITY_SECRET unset/);
    expect(s.blockchain).toBe("ARC");
    expect(await ensureWallets()).toMatchObject({ mode: "dry-run", wallets: [], created: [] });
    const r = await executeContract({ role: "ops", address: REGISTRY, abi: registryAbi, functionName: "pause", args: [] });
    expect(r.status).toBe("dry-run");
    if (r.status === "dry-run") { expect(r.reason).toMatch(/dry-run/); expect(r.calldata).toMatch(/^0x[0-9a-f]{8}$/); }
    expect(await balances("ops")).toMatchObject({ status: "dry-run", balances: [] });
    expect(await signTypedDataWithCircle("ops", { a: 1 })).toMatchObject({ status: "dry-run" });
    expect(sdk.createWallets).not.toHaveBeenCalled();
  });
  it("rejects a malformed entity secret instead of calling Circle", () => {
    live(); process.env.CIRCLE_ENTITY_SECRET = "not-hex"; __resetConfig();
    expect(circleStatus()).toMatchObject({ enabled: false, reason: expect.stringMatching(/32 bytes hex/) });
  });
});

describe("ensureWallets", () => {
  it("creates the wallet set + revenue/ops wallets once and is idempotent", async () => {
    live(); __resetConfig(); programProvisioning();
    const first = await ensureWallets();
    expect(first.mode).toBe("live");
    expect(first.walletSetId).toBe("ws1");
    expect(first.created.sort()).toEqual(["ops", "revenue"]);
    expect(sdk.createWalletSet).toHaveBeenCalledTimes(1);
    expect(sdk.createWallets).toHaveBeenCalledTimes(2);
    expect(sdk.createWallets.mock.calls[0][0]).toMatchObject({ walletSetId: "ws1", blockchains: ["ARC"], accountType: "SCA", count: 1 });

    const second = await ensureWallets();
    expect(second.created).toEqual([]);
    expect(second.wallets.map((w) => w.role)).toEqual(["ops", "revenue"]);
    expect(sdk.createWallets).toHaveBeenCalledTimes(2);
    expect(sdk.createWalletSet).toHaveBeenCalledTimes(1);
    expect((await walletByRole("ops"))?.address).toBe(OPS_ADDR.toLowerCase());
  });
  it("re-uses wallets Circle already has for the refId (no duplicate create)", async () => {
    live(); process.env.CIRCLE_WALLET_SET_ID = "ws-env"; __resetConfig();
    sdk.listWallets.mockImplementation(async ({ refId }: { refId: string }) => ({
      data: { wallets: [{ id: `old-${refId}`, address: refId.endsWith("ops") ? OPS_ADDR : REV_ADDR, blockchain: "ARC", accountType: "SCA", refId }] },
    }));
    const r = await ensureWallets();
    expect(r.created).toEqual([]);
    expect(r.walletSetId).toBe("ws-env");
    expect(sdk.createWalletSet).not.toHaveBeenCalled();
    expect(sdk.createWallets).not.toHaveBeenCalled();
    expect((await walletByRole("revenue"))?.walletId).toBe("old-complir:revenue");
  });
});

describe("executeContract", () => {
  it("submits calldata from the ops wallet and polls to a tx hash", async () => {
    live(); process.env.REGISTRY_ADDRESS = REGISTRY; __resetConfig(); programProvisioning();
    sdk.createContractExecutionTransaction.mockResolvedValue({ data: { id: "tx-1", state: "INITIATED" } });
    sdk.getTransaction
      .mockResolvedValueOnce({ data: { transaction: { state: "QUEUED" } } })
      .mockResolvedValueOnce({ data: { transaction: { state: "SENT" } } }) // SCA: hash only at CONFIRMED
      .mockResolvedValueOnce({ data: { transaction: { state: "CONFIRMED", txHash: "0x" + "ab".repeat(32) } } });
    const r = await executeContract({ role: "ops", address: REGISTRY, abi: registryAbi, functionName: "pause", args: [], pollMs: 1 });
    expect(r.status).toBe("sent");
    if (r.status !== "sent") return;
    expect(r.txHash).toBe("0x" + "ab".repeat(32));
    expect(r.state).toBe("CONFIRMED");
    expect(r.walletId).toBe("w-ops");
    expect(sdk.getTransaction).toHaveBeenCalledTimes(3);
    expect(sdk.createContractExecutionTransaction.mock.calls[0][0]).toMatchObject({
      walletId: "w-ops", contractAddress: REGISTRY, callData: r.calldata, fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
  });
  it("rejects when the transaction fails or times out", async () => {
    const failing = async () => ({ state: "FAILED", errorReason: "ESTIMATION_ERROR" });
    await expect(waitForTxHash(failing, "tx-x", { pollMs: 1, timeoutMs: 50 })).rejects.toThrow(/tx-x FAILED \(ESTIMATION_ERROR\)/);
    const stuckQueued = async () => ({ state: "QUEUED" });
    await expect(waitForTxHash(stuckQueued, "tx-y", { pollMs: 1, timeoutMs: 10 })).rejects.toThrow(/timed out in state QUEUED/);
  });
  it("enforces the ops contract allowlist (defaults to REGISTRY_ADDRESS)", async () => {
    live(); process.env.REGISTRY_ADDRESS = REGISTRY; __resetConfig(); programProvisioning();
    await ensureWallets();
    await expect(executeContract({ role: "ops", address: "0x2222222222222222222222222222222222222222", abi: registryAbi, functionName: "pause", args: [] }))
      .rejects.toBeInstanceOf(SpendingPolicyError);
    expect(sdk.createContractExecutionTransaction).not.toHaveBeenCalled();
  });
});

describe("spending policy", () => {
  it("stores the policy and enforces per-tx / rolling daily caps", async () => {
    live(); __resetConfig(); programProvisioning();
    await ensureWallets();
    const { policy, stored, cliHint } = await applySpendingPolicy("revenue", { perTxUsdc: 5, dailyUsdc: 8 });
    expect(stored).toBe(true);
    expect(policy).toMatchObject({ perTxUsdc: 5, dailyUsdc: 8, enforcement: "app" });
    expect(cliHint).toContain(`--address ${REV_ADDR.toLowerCase()} --chain ARC --policy-type stablecoin --per-tx 5 --daily 8`);
    expect((await walletByRole("revenue"))?.policy.perTxUsdc).toBe(5);
    await expect(checkSpend("revenue", { target: REGISTRY, amountUsdc: 6 })).rejects.toMatchObject({ rule: "per-tx" });
    await recordSpend("revenue", { kind: "transfer", target: REGISTRY, amountUsdc: 4 });
    await expect(checkSpend("revenue", { target: REGISTRY, amountUsdc: 4 })).resolves.toBeTruthy();
    await expect(checkSpend("revenue", { target: REGISTRY, amountUsdc: 5 })).rejects.toMatchObject({ rule: "daily" });
    await expect(applySpendingPolicy("ops", { perTxUsdc: 9, dailyUsdc: 1 })).rejects.toThrow(/perTxUsdc must be/);
  });
});

describe("signer switch", () => {
  const ATTESTER_KEY = "0x" + "11".repeat(32);
  const verdict = {
    decisionId: "d1", tier: "LOW",
    attestation: {
      signature: "0x" + "cd".repeat(65),
      typedData: { message: { subject: "0x3333333333333333333333333333333333333333", tier: 1, score: 10, decisionHash: "0x" + "ef".repeat(32), issuedAt: 1_700_000_000, validUntil: 1_700_600_000 } },
    },
  } as unknown as Verdict;

  it("defaults to local and falls back to local when SIGNER_MODE=circle but Circle is unset", () => {
    expect(signerMode()).toBe("local");
    process.env.SIGNER_MODE = "circle"; __resetConfig();
    expect(signerMode()).toBe("local");
    live(); __resetConfig();
    expect(signerMode()).toBe("circle");
  });
  it("is a no-op without REGISTRY_ADDRESS/ATTESTER_PRIVATE_KEY in either mode", async () => {
    process.env.SIGNER_MODE = "circle"; live(); __resetConfig();
    expect(await writeAttestationToRegistry(verdict)).toBeNull();
    expect(sdk.createContractExecutionTransaction).not.toHaveBeenCalled();
  });
  it("relays attest() through the Circle ops wallet in circle mode", async () => {
    process.env.SIGNER_MODE = "circle"; process.env.REGISTRY_ADDRESS = REGISTRY; process.env.ATTESTER_PRIVATE_KEY = ATTESTER_KEY;
    live(); __resetConfig(); programProvisioning();
    sdk.createContractExecutionTransaction.mockResolvedValue({ data: { id: "tx-att", state: "INITIATED" } });
    sdk.getTransaction.mockResolvedValue({ data: { transaction: { state: "COMPLETE", txHash: "0x" + "77".repeat(32) } } });
    const hash = await writeAttestationToRegistry(verdict);
    expect(hash).toBe("0x" + "77".repeat(32));
    const call = sdk.createContractExecutionTransaction.mock.calls[0][0] as { contractAddress: string; callData: string; refId: string };
    expect(call.contractAddress).toBe(REGISTRY);
    expect(call.refId).toBe("complir:attest:d1");
    expect(call.callData.startsWith("0x")).toBe(true);
  });
});
