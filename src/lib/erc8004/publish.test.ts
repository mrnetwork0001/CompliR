import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../__tests__/setup";
import { __resetConfig } from "../config";
import { __resetDb } from "../store/db";
import type { Address, Verdict } from "../types";
import { FEEDBACK_TAG1, publishAgentVerdict, responseFromScore } from "./publish";
import { __resetErc8004Migration } from "./store";
import { ERC8004_ADDRESSES } from "./abi";

const KEY = `0x${"ab".repeat(32)}` as const;
const REG = ERC8004_ADDRESSES[5042];
const H1 = `0x${"11".repeat(32)}` as const;

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    address: "0x024b82335c29fa5606a8ea5c1d24fc9ead50700c" as Address, score: 8, tier: "LOW", recommendedLimits: { maxPerTxUsdc: 1, maxPerDayUsdc: 1 },
    reasons: [], rationale: "", eddRequested: [], nextRescreenAt: "", decisionId: "dec_test1", screenedAt: "",
    attestation: { typedData: { message: { decisionHash: `0x${"cd".repeat(32)}` } } as never, signature: "0x", attester: "0x" as Address, validUntil: 0, registryTx: null },
    evidence: { agent: { registered: true, role: "owner", agentId: "1", agentURI: null, owner: null, agentWallet: null, registries: { chainId: 5042, ...REG }, reputation: null, validations: null, disputes: [] } } as never,
    ...over,
  };
}

describe("erc8004 publish", () => {
  beforeEach(() => { process.env.ERC8004_PUBLISH = "1"; delete process.env.ERC8004_AGENT_ID; __resetConfig(); __resetDb(); __resetErc8004Migration(); });
  afterEach(() => { delete process.env.ERC8004_PUBLISH; });

  it("maps risk score → response 100-score, clamped", () => {
    expect(responseFromScore(0)).toBe(100);
    expect(responseFromScore(8)).toBe(92);
    expect(responseFromScore(100)).toBe(0);
    expect(responseFromScore(140)).toBe(0);
  });

  it("skips when the gate is off or the subject is not an agent", async () => {
    delete process.env.ERC8004_PUBLISH;
    expect((await publishAgentVerdict(verdict(), { privateKey: KEY })).skipped).toMatch(/ERC8004_PUBLISH/);
    process.env.ERC8004_PUBLISH = "1";
    expect((await publishAgentVerdict(verdict({ evidence: { agent: null } as never }), { privateKey: KEY })).skipped).toMatch(/not a registered agent/);
    process.env.ERC8004_AGENT_ID = "1";
    expect((await publishAgentVerdict(verdict(), { privateKey: KEY })).skipped).toBe("own agent");
  });

  it("falls back to ReputationRegistry.giveFeedback when no validation request names us, and ledgers it", async () => {
    const writeContract = vi.fn(async () => `0x${"ee".repeat(32)}` as const);
    const readContract = vi.fn(async () => []);
    const ledger = vi.fn(async (input: { kind: string; payload: unknown }) => ({ id: "dec_noop1", ...input }) as never);
    const r = await publishAgentVerdict(verdict(), {
      privateKey: KEY, force: true, ledger,
      publicClient: { readContract, waitForTransactionReceipt: vi.fn(async () => ({})) } as never,
      walletClient: { writeContract } as never,
    });
    expect(r.published).toBe(true);
    expect(r.mode).toBe("giveFeedback");
    expect(r.response).toBe(92);
    const call = (writeContract.mock.calls as unknown as [{ address: string; functionName: string; args: unknown[] }][])[0][0];
    expect(call.address).toBe(REG.reputation);
    expect(call.functionName).toBe("giveFeedback");
    expect(call.args.slice(0, 5)).toEqual([1n, 92n, 0, FEEDBACK_TAG1, "LOW"]);
    expect(call.args[6]).toContain("/api/v1/decision/dec_test1");
    expect(call.args[7]).toBe(`0x${"cd".repeat(32)}`);
    expect(ledger).toHaveBeenCalledTimes(1);
    const payload = ledger.mock.calls[0][0].payload as { type: string; mode: string; txHash: string };
    expect(ledger.mock.calls[0][0].kind).toBe("NOOP");
    expect(payload.type).toBe("ERC8004_VALIDATION");
    expect(payload.mode).toBe("giveFeedback");
    expect(r.ledgerId).toBe("dec_noop1");
  });

  it("answers an open validationRequest addressed to us via ValidationRegistry.validationResponse", async () => {
    const writeContract = vi.fn(async () => `0x${"ff".repeat(32)}` as const);
    const readContract = vi.fn(async (c: { functionName: string }) => {
      if (c.functionName === "getValidatorRequests") return [H1];
      if (c.functionName === "getValidationStatus") return ["0x0000000000000000000000000000000000000001", 1n, 0, `0x${"0".repeat(64)}`, "", 0n];
      throw new Error("unexpected");
    });
    const r = await publishAgentVerdict(verdict({ score: 30, tier: "MEDIUM" }), {
      privateKey: KEY, force: true, ledger: vi.fn(async () => ({ id: "dec_noop2" }) as never),
      publicClient: { readContract, waitForTransactionReceipt: vi.fn(async () => ({})) } as never,
      walletClient: { writeContract } as never,
    });
    expect(r.mode).toBe("validationResponse");
    expect(r.requestHash).toBe(H1);
    const call = (writeContract.mock.calls as unknown as [{ address: string; functionName: string; args: unknown[] }][])[0][0];
    expect(call.address).toBe(REG.validation);
    expect(call.functionName).toBe("validationResponse");
    expect(call.args[0]).toBe(H1);
    expect(call.args[1]).toBe(70);
    expect(call.args[4]).toBe("MEDIUM");
  });

  it("rate-limits repeat publications about the same agent", async () => {
    const deps = {
      privateKey: KEY, ledger: vi.fn(async () => ({ id: "dec_noop3" }) as never),
      publicClient: { readContract: vi.fn(async () => []), waitForTransactionReceipt: vi.fn(async () => ({})) } as never,
      walletClient: { writeContract: vi.fn(async () => `0x${"ee".repeat(32)}` as const) } as never,
    };
    const first = await publishAgentVerdict(verdict(), deps);
    expect(first.published).toBe(true);
    const second = await publishAgentVerdict(verdict(), deps);
    expect(second.published).toBe(false);
    expect(second.skipped).toMatch(/min 24 h/);
  });

  it("records a failed write with its error and no ledger entry", async () => {
    const ledger = vi.fn();
    const r = await publishAgentVerdict(verdict(), {
      privateKey: KEY, force: true, ledger: ledger as never,
      publicClient: { readContract: vi.fn(async () => []), waitForTransactionReceipt: vi.fn() } as never,
      walletClient: { writeContract: vi.fn(async () => { throw new Error("execution reverted: unknown"); }) } as never,
    });
    expect(r.published).toBe(false);
    expect(r.error).toContain("reverted");
    expect(ledger).not.toHaveBeenCalled();
  });
});
