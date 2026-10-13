import "../__tests__/setup";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../store/db";
import { insertEdges, migrateTrustmap } from "../trustmap/store";
import type { Address } from "../types";
import { migrateNetwork, networkSignals, upsertPayeeFunders as recordFunders } from "./index";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const NOW = 1_800_000_000;
const DAY = 86_400;

const S = addr(0x5111); // subject
const F = addr(0xf1); // shared funder
const G = addr(0xf2); // another funder

async function screening(subject: Address, clientId: string | null, tier: "LOW" | "MEDIUM" | "HIGH", at: number) {
  await db().execute({
    sql: `INSERT INTO screenings (subject, client_id, score, tier, reason_codes, decision_id, payer, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    args: [subject, clientId, tier === "HIGH" ? 90 : 10, tier, "[]", `dec_${at}`, "outside", at],
  });
}

beforeAll(async () => {
  await migrateNetwork();
  await migrateTrustmap();
  // held elsewhere: two outside clients HIGH in-window, one outside client HIGH but stale, one MEDIUM, internal ids, and "self"
  await screening(S, "client-a", "HIGH", NOW - 1 * DAY);
  await screening(S, "client-b", "HIGH", NOW - 2 * DAY);
  await screening(S, "client-b", "HIGH", NOW - 3 * DAY); // same client twice → still one
  await screening(S, "client-c", "HIGH", NOW - 9 * DAY); // outside the 7 d window
  await screening(S, "client-d", "MEDIUM", NOW - 1 * DAY); // not HIGH
  await screening(S, "watcher", "HIGH", NOW - 1 * DAY); // internal
  await screening(S, "Web-Explorer", "HIGH", NOW - 1 * DAY); // internal (case-insensitive)
  await screening(S, null, "HIGH", NOW - 1 * DAY); // anonymous
  await screening(S, "self", "HIGH", NOW - 1 * DAY);
  // shared funder: client "self" has payees p1..p3 funded by F, p4 funded by G; client "other" has p5 funded by F
  await recordFunders("self", addr(0xa1), [F], NOW);
  await recordFunders("self", addr(0xa2), [F, G], NOW);
  await recordFunders("self", addr(0xa3), [F], NOW);
  await recordFunders("self", addr(0xa4), [G], NOW);
  await recordFunders("other", addr(0xa5), [F], NOW);
  // trust map: F also sent to a graded node
  await insertEdges([{ from: F, to: addr(0xa6), usdc: 10, txHash: tx(1), block: 1 }], NOW);
});

describe("networkSignals / heldElsewhere", () => {
  it("counts distinct outside clients rated HIGH in the window, excluding self, internal ids and stale rows", async () => {
    const sig = await networkSignals(S, "self", { now: NOW, funders: [] });
    expect(sig.heldElsewhere).toEqual({ clients: 2, lastAt: NOW - 1 * DAY });
    expect(sig.windowDays).toBe(7);
  });
  it("with no client (public route) the caller's own screens are not special-cased but internal ids still are", async () => {
    const sig = await networkSignals(S, null, { now: NOW, funders: [] });
    expect(sig.heldElsewhere.clients).toBe(3); // client-a, client-b, self
    expect(sig.sharedFunder).toEqual({ count: 0, funder: null });
  });
  it("is neutral for an unknown address", async () => {
    const sig = await networkSignals(addr(0x9999), "self", { now: NOW, funders: [] });
    expect(sig.heldElsewhere).toEqual({ clients: 0, lastAt: null });
    expect(sig.concentrationHint).toBeNull();
  });
});

describe("networkSignals / sharedFunder + concentration", () => {
  it("counts only THIS client's other payees sharing a funder, and picks the funder with most matches", async () => {
    const sig = await networkSignals(S, "self", { now: NOW, funders: [G, F] });
    expect(sig.sharedFunder).toEqual({ count: 3, funder: F });
  });
  it("another client sees its own (smaller) count - never the first client's payees", async () => {
    const sig = await networkSignals(S, "other", { now: NOW, funders: [F] });
    expect(sig.sharedFunder).toEqual({ count: 1, funder: F });
  });
  it("concentrationHint is network-wide (all clients' payees + trust map edges) above the threshold, count only", async () => {
    const sig = await networkSignals(S, "other", { now: NOW, funders: [F] });
    // p1, p2, p3 (self) + p5 (other) + a6 (trust map) = 5 other payees of F
    expect(sig.concentrationHint).toEqual({ funder: F, otherPayees: 5 });
    const g = await networkSignals(S, "other", { now: NOW, funders: [G] });
    expect(g.concentrationHint).toBeNull(); // G funded only 2 → below NETWORK_MIN_CONCENTRATION (3)
    expect((await networkSignals(S, "other", { now: NOW, funders: [G], minConcentration: 2 })).concentrationHint).toEqual({ funder: G, otherPayees: 2 });
  });
  it("a payee never counts itself; recordFunders upserts", async () => {
    expect(await recordFunders("self", addr(0xa1), [F, F, addr(0xa1)], NOW + 1)).toBe(1);
    const sig = await networkSignals(addr(0xa1), "self", { now: NOW, funders: [F] });
    expect(sig.sharedFunder).toEqual({ count: 2, funder: F }); // p2, p3 - not p1 itself
  });
  it("falls back to remembered funders when none are supplied (public route)", async () => {
    const sig = await networkSignals(addr(0xa1), null, { now: NOW });
    expect(sig.concentrationHint?.funder).toBe(F);
  });
});
