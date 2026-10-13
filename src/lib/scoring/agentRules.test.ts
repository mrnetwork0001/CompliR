import { describe, expect, it } from "vitest";
import type { AgentSignal, EvidenceBundle } from "../types";
import { INBOUND_FLAGGED_LOOKBACK_DAYS, WEIGHTS, scoreEvidence } from "./rules";

const NOW = 1_760_400_000;
const base = (): EvidenceBundle => ({
  subject: { address: "0x00000000000000000000000000000000000000aa", firstSeen: NOW - 90 * 86400, txCount: 50, usdcBlacklisted: false, protocolBlocklisted: false, sanctions: [] },
  funders: [], lookalikes: [], payeeChanged: null, concentration: null, priorTier: null, collectedAt: NOW, depth: 1, network: null,
});
const agent = (over: Partial<AgentSignal> = {}): AgentSignal => ({
  registered: true, role: "owner", agentId: "1", agentURI: "https://x/erc8004.json", owner: "0x00000000000000000000000000000000000000aa", agentWallet: null,
  registries: { chainId: 5042, identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63", validation: "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58" },
  reputation: { count: 2, avg: 90, negative: 0, clients: 2 }, validations: { count: 0, responded: 0, nonSelf: 0, failed: 0, validators: [], last: null }, disputes: [], ...over,
});

describe("rules: ERC-8004 agent + CCTP inbound", () => {
  it("weights", () => {
    expect(WEIGHTS.AGENT_REGISTERED).toBe(-5);
    expect(WEIGHTS.AGENT_VALIDATED).toBe(-5);
    expect(WEIGHTS.AGENT_DISPUTED).toBe(15);
    expect(WEIGHTS.INBOUND_FLAGGED).toBe(20);
    expect(INBOUND_FLAGGED_LOOKBACK_DAYS).toBe(30);
  });

  it("AGENT_REGISTERED is a positive signal that never pushes the score below 0; evidence carries agentId + registries", () => {
    const r = scoreEvidence({ ...base(), agent: agent() });
    expect(r.score).toBe(0);
    const reg = r.reasons.find((x) => x.code === "AGENT_REGISTERED")!;
    expect(reg.weight).toBe(-5);
    expect(reg.evidence.agentId).toBe("1");
    expect((reg.evidence.registries as { identity: string }).identity).toBe("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
    expect(r.reasons.map((x) => x.code)).not.toContain("CLEAN");
  });

  it("subtracts from a positive score (FRESH_WALLET 8 - 5 - 5 = 0 → LOW)", () => {
    const b = base();
    b.subject.txCount = 2;
    const r = scoreEvidence({ ...b, agent: agent({ validations: { count: 1, responded: 1, nonSelf: 1, failed: 0, validators: ["0x00000000000000000000000000000000000000bb"], last: { requestHash: `0x${"1".repeat(64)}`, validator: "0x00000000000000000000000000000000000000bb", response: 95, tag: "", at: NOW - 10 } } }) });
    expect(r.reasons.map((x) => x.code).sort()).toEqual(["AGENT_REGISTERED", "AGENT_VALIDATED", "FRESH_WALLET"]);
    expect(r.score).toBe(0);
  });

  it("AGENT_VALIDATED needs a non-self validator", () => {
    const r = scoreEvidence({ ...base(), agent: agent({ validations: { count: 1, responded: 1, nonSelf: 0, failed: 0, validators: ["0x00000000000000000000000000000000000000aa"], last: null } }) });
    expect(r.reasons.map((x) => x.code)).not.toContain("AGENT_VALIDATED");
  });

  it("AGENT_DISPUTED +15 on negative feedback / failed validation", () => {
    const r = scoreEvidence({ ...base(), agent: agent({ reputation: { count: 3, avg: 10, negative: 1, clients: 3 }, disputes: [{ source: "feedback", client: "0x00000000000000000000000000000000000000cc", value: -50, tag: "" }] }) });
    expect(r.score).toBe(10); // -5 + 15
    const d = r.reasons.find((x) => x.code === "AGENT_DISPUTED")!;
    expect(d.weight).toBe(15);
    expect(d.evidence.count).toBe(1);
  });

  it("INBOUND_FLAGGED +20 inside 30 days, nothing when stale or zero", () => {
    const hit = scoreEvidence({ ...base(), inbound: { flaggedCount: 2, lastAt: NOW - 5 * 86400, sources: ["ethereum", "base"], windowDays: 30 } });
    expect(hit.score).toBe(20);
    expect(hit.reasons[0].code).toBe("INBOUND_FLAGGED");
    expect(hit.reasons[0].evidence.sources).toEqual(["base", "ethereum"]);
    expect(scoreEvidence({ ...base(), inbound: { flaggedCount: 1, lastAt: NOW - 40 * 86400, sources: ["base"], windowDays: 60 } }).reasons[0].code).toBe("CLEAN");
    expect(scoreEvidence({ ...base(), inbound: { flaggedCount: 0, lastAt: null, sources: [], windowDays: 30, seen: 3 } }).reasons[0].code).toBe("CLEAN");
  });

  it("is deterministic (same bundle → same bytes)", () => {
    const b = { ...base(), agent: agent({ disputes: [{ source: "validation", validator: "0x00000000000000000000000000000000000000bb", response: 10, tag: "fail", requestHash: `0x${"2".repeat(64)}` }, { source: "feedback", client: "0x00000000000000000000000000000000000000cc", value: -1, tag: "" }] }), inbound: { flaggedCount: 1, lastAt: NOW - 1, sources: ["base"], windowDays: 30 } };
    expect(JSON.stringify(scoreEvidence(b))).toBe(JSON.stringify(scoreEvidence(JSON.parse(JSON.stringify(b)))));
  });
});
