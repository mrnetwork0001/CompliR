import { beforeEach, describe, expect, it, vi } from "vitest";
import "../__tests__/setup";
import type { Address } from "../types";
import { agentFacts, type ReadClient } from "./read";
import { ERC8004_ADDRESSES } from "./abi";

const REG = ERC8004_ADDRESSES[5042];
const OWNER = "0x024b82335c29fa5606a8ea5c1d24fc9ead50700c" as Address;
const WALLET = "0xd334ab5151c624cada654854e2879903dc4217ed" as Address;
const VALIDATOR = "0xc742ada2872a042dd36d2e706907b4036968960c" as Address;
const CLIENT = "0xa4c5190348a6ac9ce33a9dd27cf9f1a18762ee02" as Address;
const H1 = `0x${"11".repeat(32)}` as const;
const H2 = `0x${"22".repeat(32)}` as const;

type Call = { address: string; functionName: string; args?: readonly unknown[] };

function mockClient(overrides: Partial<Record<string, (c: Call) => unknown>> = {}) {
  const calls: Call[] = [];
  const base: Record<string, (c: Call) => unknown> = {
    balanceOf: (c) => (String(c.args?.[0]).toLowerCase() === OWNER ? 1n : 0n),
    ownerOf: () => OWNER,
    getAgentWallet: () => WALLET,
    tokenURI: () => "https://apexfaucet.xyz/.well-known/erc8004.json",
    getClients: () => [CLIENT],
    getSummary: (c) => (c.address.toLowerCase() === REG.reputation.toLowerCase() ? [1n, 90n, 0] : [1n, 95]),
    readAllFeedback: () => [[CLIENT], [1n], [90n], [0], ["quality"], [""], [false]],
    getAgentValidations: () => [H1, H2],
    getValidationStatus: (c) => (c.args?.[0] === H1 ? [VALIDATOR, 1n, 95, `0x${"0".repeat(64)}`, "LOW", 1_760_000_000n] : [OWNER, 1n, 0, `0x${"0".repeat(64)}`, "", 0n]),
  };
  const fns = { ...base, ...overrides };
  const readContract = vi.fn(async (c: Call) => {
    calls.push(c);
    const f = fns[c.functionName];
    if (!f) throw new Error(`unexpected ${c.functionName}`);
    return f(c);
  });
  return { calls, readContract } as unknown as ReadClient & { calls: Call[] };
}

const lookup = async (a: Address) => (a === OWNER || a === WALLET ? [{ agentId: "1", owner: OWNER, wallet: WALLET, agentUri: null, registeredBlock: 1, updatedAt: 0 }] : []);

describe("erc8004 agentFacts", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("parses identity + reputation + validations for an owner", async () => {
    const client = mockClient();
    const f = await agentFacts(OWNER, { client, lookup, lazySync: false });
    expect(f).not.toBeNull();
    expect(f!.registered).toBe(true);
    expect(f!.role).toBe("owner");
    expect(f!.agentId).toBe("1");
    expect(f!.agentURI).toContain("apexfaucet");
    expect(f!.owner).toBe(OWNER);
    expect(f!.agentWallet).toBe(WALLET);
    expect(f!.registries.identity).toBe(REG.identity);
    expect(f!.reputation).toEqual({ count: 1, avg: 90, negative: 0, clients: 1 });
    expect(f!.validations?.count).toBe(2);
    expect(f!.validations?.responded).toBe(1); // H2 unanswered (lastUpdate 0)
    expect(f!.validations?.nonSelf).toBe(1);
    expect(f!.validations?.validators).toEqual([VALIDATOR]);
    expect(f!.validations?.last?.requestHash).toBe(H1);
    expect(f!.disputes).toEqual([]);
  });

  it("recognises the agentWallet as role=wallet", async () => {
    const f = await agentFacts(WALLET, { client: mockClient(), lookup, lazySync: false });
    expect(f?.role).toBe("wallet");
    expect(f?.agentId).toBe("1");
  });

  it("returns null for a plain address", async () => {
    const client = mockClient();
    const f = await agentFacts("0x0000000000000000000000000000000000000abc", { client, lookup, lazySync: false });
    expect(f).toBeNull();
    expect(client.calls.map((c) => c.functionName)).toEqual(["balanceOf"]);
  });

  it("reports indexPending when balanceOf > 0 but the index has no row", async () => {
    const f = await agentFacts(OWNER, { client: mockClient(), lookup: async () => [], lazySync: false });
    expect(f?.registered).toBe(true);
    expect(f?.agentId).toBeNull();
    expect(f?.indexPending).toBe(true);
  });

  it("collects disputes from negative feedback, dispute tags and failed validations; self-validations do not count as nonSelf", async () => {
    const client = mockClient({
      readAllFeedback: () => [[CLIENT, CLIENT], [1n, 2n], [-50n, 80n], [0, 0], ["", "dispute"], ["", ""], [false, false]],
      getValidationStatus: (c) => (c.args?.[0] === H1 ? [WALLET, 1n, 10, `0x${"0".repeat(64)}`, "", 1n] : [VALIDATOR, 1n, 20, `0x${"0".repeat(64)}`, "failed", 2n]),
    });
    const f = await agentFacts(OWNER, { client, lookup, lazySync: false });
    expect(f?.reputation?.negative).toBe(2);
    expect(f?.validations?.failed).toBe(2);
    expect(f?.validations?.nonSelf).toBe(1); // WALLET is self
    expect(f?.disputes.map((d) => d.source)).toEqual(["feedback", "feedback", "validation", "validation"]);
  });

  it("degrades registry failures to null summaries, never throws", async () => {
    const client = mockClient({ getClients: () => { throw new Error("rpc down"); }, getAgentValidations: () => { throw new Error("rpc down"); } });
    const f = await agentFacts(OWNER, { client, lookup, lazySync: false });
    expect(f?.registered).toBe(true);
    expect(f?.reputation).toBeNull();
    expect(f?.validations).toBeNull();
    expect(f?.disputes).toEqual([]);
  });

  it("ignores a stale index row whose live owner/wallet no longer match", async () => {
    const client = mockClient({ balanceOf: () => 0n, ownerOf: () => "0x00000000000000000000000000000000000000ff", getAgentWallet: () => "0x00000000000000000000000000000000000000ee" });
    const f = await agentFacts(OWNER, { client, lookup, lazySync: false });
    expect(f).toBeNull();
  });
});
