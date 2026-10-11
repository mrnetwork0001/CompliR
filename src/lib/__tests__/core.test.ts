import "./setup";
import { describe, it, expect, beforeAll } from "vitest";
import { migrate, recentScreenings, publicStats, latestAttestation, upsertWatch, dueWatches } from "../store";
import { appendDecision, verifyChain, getDecision, computeMerkleRoot, merkleProof, verifyProof, anchorPending } from "../ledger";
import { screen } from "../pipeline";
import { verifyAttestation } from "../attest";
import { db } from "../store/db";

beforeAll(async () => { await migrate(); });

describe("decision log", () => {
  it("chains hashes and detects tampering", async () => {
    const a = await appendDecision({ kind: "NOOP", subject: null, clientId: null, payload: { n: 1 } });
    const b = await appendDecision({ kind: "NOOP", subject: null, clientId: null, payload: { n: 2 } });
    expect(b.prevHash).toBe(a.hash);
    expect((await verifyChain()).ok).toBe(true);
    await db().execute({ sql: "UPDATE decisions SET payload = ? WHERE id = ?", args: [JSON.stringify({ n: 99 }), a.id] });
    const v = await verifyChain();
    expect(v.ok).toBe(false); expect(v.brokenAt).toBe(a.seq);
    await db().execute({ sql: "UPDATE decisions SET payload = ? WHERE id = ?", args: [JSON.stringify({ n: 1 }), a.id] });
    expect((await verifyChain()).ok).toBe(true);
    expect((await getDecision(a.id))?.seq).toBe(a.seq);
  });
  it("merkle root + proof round trip, anchoring marks entries", async () => {
    const hs = [1, 2, 3].map((i) => `0x${i.toString(16).padStart(64, "0")}` as const);
    const root = computeMerkleRoot(hs);
    expect(verifyProof(hs[2], merkleProof(hs, 2), root)).toBe(true);
    const res = await anchorPending(async () => "0xabc" as `0x${string}`);
    expect(res?.count).toBeGreaterThan(0);
    expect((await anchorPending(async () => "0xdef" as `0x${string}`))).toBeNull(); // nothing left but the ANCHOR entry itself
  });
});

describe("pipeline (fallback analyst, mock evidence)", () => {
  it("produces a signed, verifiable verdict and records it", async () => {
    const addr = "0x000000000000000000000000000000000000cafe" as const;
    const v = await screen({ address: addr, amountUsdc: 50, clientId: "0xclient1" }, { writeOnChain: false });
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(v.tier);
    expect(v.decisionId).toMatch(/^dec_/);
    expect(await verifyAttestation(v.attestation)).toBe(true);
    expect(v.rationale.length).toBeGreaterThan(10);
    const feed = await recentScreenings(5);
    expect(feed[0].decisionId).toBe(v.decisionId);
    expect(feed[0].addressMasked).toContain("…");
    const att = await latestAttestation(addr);
    expect(att?.decisionId).toBe(v.decisionId);
    const stats = await publicStats();
    expect(stats.screenings).toBeGreaterThan(0); expect(stats.ownWalletsExcluded).toBe(true);
  });
  it("watch upsert + due", async () => {
    const w = await upsertWatch({ address: "0x000000000000000000000000000000000000beef", webhookUrl: "https://example.com/hook", clientId: "c1" });
    expect(w.id).toMatch(/^wat_/);
    expect((await dueWatches()).some((d) => d.id === w.id)).toBe(true);
  });
});
