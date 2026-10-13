import { describe, expect, it } from "vitest";
import { NETWORK_HELD_ELSEWHERE_SINGLE_WEIGHT, NETWORK_SHARED_FUNDER_MIN_PAYEES, WEIGHTS, scoreEvidence } from "../scoring/rules";
import type { Address, EvidenceBundle, NetworkSignal } from "../types";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const S = addr(0x51);
const F = addr(0xf1);
const NOW = 1_800_000_000;

function bundle(network: NetworkSignal | null, extra: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    subject: { address: S, firstSeen: NOW - 400 * 86_400, txCount: 500, usdcBlacklisted: false, protocolBlocklisted: false, sanctions: [] },
    funders: [], lookalikes: [], payeeChanged: null, concentration: null, priorTier: null, collectedAt: NOW, depth: 1, network, ...extra,
  };
}
const net = (p: Partial<NetworkSignal>): NetworkSignal => ({
  heldElsewhere: { clients: 0, lastAt: null }, sharedFunder: { count: 0, funder: null }, concentrationHint: null, windowDays: 7, ...p,
});
const find = (b: EvidenceBundle, code: string) => scoreEvidence(b).reasons.find((r) => r.code === code);

describe("rules: NETWORK_HELD_ELSEWHERE", () => {
  it("absent network → CLEAN, no network codes", () => {
    const r = scoreEvidence(bundle(null));
    expect(r.reasons.map((x) => x.code)).toEqual(["CLEAN"]);
    const r2 = scoreEvidence(bundle(net({})));
    expect(r2.reasons.map((x) => x.code)).toEqual(["CLEAN"]);
  });
  it("one other client → 10; two or more → 20; evidence is counts only", () => {
    const one = find(bundle(net({ heldElsewhere: { clients: 1, lastAt: NOW - 3600 } })), "NETWORK_HELD_ELSEWHERE");
    expect(one?.weight).toBe(NETWORK_HELD_ELSEWHERE_SINGLE_WEIGHT);
    expect(one?.weight).toBe(10);
    const two = find(bundle(net({ heldElsewhere: { clients: 2, lastAt: NOW - 3600 } })), "NETWORK_HELD_ELSEWHERE");
    expect(two?.weight).toBe(WEIGHTS.NETWORK_HELD_ELSEWHERE);
    expect(two?.weight).toBe(20);
    const six = find(bundle(net({ heldElsewhere: { clients: 6, lastAt: NOW - 3600 } })), "NETWORK_HELD_ELSEWHERE");
    expect(six?.weight).toBe(20);
    expect(six?.evidence).toMatchObject({ otherClients: 6, windowDays: 7, anonymised: true });
    expect(JSON.stringify(six?.evidence)).not.toMatch(/client-|clientId/);
  });
});

describe("rules: NETWORK_SHARED_FUNDER", () => {
  it("fires at ≥3 of the client's own payees with weight 8, not below", () => {
    expect(NETWORK_SHARED_FUNDER_MIN_PAYEES).toBe(3);
    expect(find(bundle(net({ sharedFunder: { count: 2, funder: F } })), "NETWORK_SHARED_FUNDER")).toBeUndefined();
    const hit = find(bundle(net({ sharedFunder: { count: 3, funder: F } })), "NETWORK_SHARED_FUNDER");
    expect(hit?.weight).toBe(WEIGHTS.NETWORK_SHARED_FUNDER);
    expect(hit?.weight).toBe(8);
    expect(hit?.evidence).toMatchObject({ sharedFunder: F, yourPayees: 3 });
  });
  it("concentration (network-wide hint) still drives HIGH_CONCENTRATION; both can stack and stay deterministic", () => {
    const b = bundle(net({ sharedFunder: { count: 4, funder: F }, heldElsewhere: { clients: 2, lastAt: NOW } }), { concentration: { sharedFunder: F, otherPayees: 7 } });
    const r = scoreEvidence(b);
    expect(r.reasons.map((x) => x.code)).toEqual(["NETWORK_HELD_ELSEWHERE", "HIGH_CONCENTRATION", "NETWORK_SHARED_FUNDER"]);
    expect(r.score).toBe(20 + 10 + 8);
    expect(scoreEvidence(b)).toEqual(r);
  });
});
