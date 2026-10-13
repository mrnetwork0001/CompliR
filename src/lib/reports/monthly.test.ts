import "../__tests__/setup";
process.env.ATTESTER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
process.env.OWN_WALLETS = "0x00000000000000000000000000000000000000aa";
process.env.ARC_EXPLORER_URL = "https://explorer.arc.network";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize, hashCanonical } from "../attest/canonical";
import { __resetConfig } from "../config";
import { appendDecision, listDecisions } from "../ledger";
import { __resetRefunds } from "../refunds";
import { __resetStats, publishDailyStats } from "../stats";
import { __resetDb, db } from "../store/db";
import { recordScreening } from "../store/repo";
import { __resetTrustmapMigration, addInflow, migrateTrustmap } from "../trustmap/store";
import type { Verdict } from "../types";
import { __resetMonthly, __resetReports, generateMonthlyReport, getMonthly, listMonthlyPeriods, monthPeriod, publishMonthly, publishReport, renderMarkdownHtml } from "./index";

const PERIOD = "2026-09";
const { from, to } = monthPeriod(PERIOD);
const OUTSIDE = "0x857b06519e91e3a54538791bdbb0e22373e36b66";
const A = "0x1111111111111111111111111111111111111111";
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function verdict(tier: Verdict["tier"], subject: string): Verdict {
  return {
    address: subject as `0x${string}`, score: tier === "HIGH" ? 90 : 5, tier, recommendedLimits: { maxPerTxUsdc: 1, maxPerDayUsdc: 2 }, reasons: [], rationale: "", eddRequested: [],
    nextRescreenAt: "", decisionId: "dec_x", screenedAt: "", evidence: {} as Verdict["evidence"],
    attestation: { typedData: { domain: { name: "CompliR", version: "1", chainId: 5042, verifyingContract: "0x" }, types: { Attestation: [] }, primaryType: "Attestation", message: { subject: subject as `0x${string}`, tier: 1, score: 1, decisionHash: "0x", issuedAt: from, validUntil: from + 10 } }, signature: "0x", attester: "0x", validUntil: from + 10, registryTx: null },
  };
}

async function seed() {
  const d = db();
  await migrateTrustmap();
  const day1 = from + 3600, day2 = from + 86_400 + 3600, day20 = from + 19 * 86_400 + 3600;
  const ins = (p: { tx: string; payer: string; amt: number; at: number; refunded?: number }) =>
    d.execute({ sql: `INSERT INTO payments (tx_hash, payer, amount_usdc, endpoint, refunded, created_at) VALUES (?,?,?,?,?,?)`, args: [p.tx, p.payer, p.amt, "/api/v1/screen", p.refunded ?? 0, p.at] });
  await ins({ tx: tx(1), payer: OUTSIDE, amt: 0.01, at: day1 });
  await ins({ tx: tx(2), payer: OUTSIDE, amt: 0.01, at: day2, refunded: 1 });
  await ins({ tx: tx(3), payer: "0x00000000000000000000000000000000000000aa", amt: 0.05, at: day2 });
  await ins({ tx: tx(4), payer: OUTSIDE, amt: 0.02, at: day20 });
  await recordScreening(verdict("HIGH", A), "acme", "outside");
  await recordScreening(verdict("LOW", A), "acme", "outside");
  await recordScreening(verdict("LOW", A), "web-explorer", "own");
  await d.execute({ sql: `UPDATE screenings SET created_at = ?`, args: [day2] });
  await d.execute({ sql: `INSERT INTO edd_requests (id, subject, decision_id, questions, response, status, created_at, answered_at) VALUES (?,?,?,?,?,?,?,?)`, args: ["edd_1", A, "dec_x", "[]", JSON.stringify({ rescreen: { tier: "LOW" } }), "ANSWERED", day1, day2] });
  await d.execute({ sql: `INSERT INTO edd_requests (id, subject, decision_id, questions, response, status, created_at, answered_at) VALUES (?,?,?,?,?,?,?,?)`, args: ["edd_2", A, "dec_x", "[]", JSON.stringify({ rescreen: { tier: "HIGH" } }), "REVIEWED", day1, day20] });
  await d.execute({ sql: `INSERT INTO edd_requests (id, subject, decision_id, questions, response, status, created_at, answered_at) VALUES (?,?,?,?,NULL,'OPEN',?,NULL)`, args: ["edd_3", A, "dec_x", "[]", day20] });
  await appendDecision({ kind: "TIER_CHANGE", subject: A as `0x${string}`, clientId: "watcher", payload: { from: "LOW", to: "HIGH", decisionId: "dec_tc" } });
  await appendDecision({ kind: "PAYOUT", subject: A as `0x${string}`, clientId: "treasury-agent", payload: { type: "PAYOUT", status: "HELD", paidUsdc: 0, heldUsdc: 10, simulated: true } });
  await d.execute({ sql: `UPDATE decisions SET created_at = ?`, args: [day2] });
  await addInflow(A as `0x${string}`, 1, 5, day1 + 60);
  await addInflow(A as `0x${string}`, 2, 5, day2 + 60);
  await publishDailyStats("2026-09-01", { now: to + 1 });
  await publishDailyStats("2026-09-02", { now: to + 1 });
  await publishDailyStats("2026-09-03", { now: to + 1 }); // no ticks
}

beforeEach(() => {
  __resetDb(); __resetRefunds(); __resetReports(); __resetMonthly(); __resetStats(); __resetConfig(); __resetTrustmapMigration();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const dir = mkdtempSync(path.join(tmpdir(), "complir-monthly-"));
  writeFileSync(path.join(dir, "notes.json"), JSON.stringify({
    notes: [{ date: "2026-09-05", text: "Gas Station enabled." }, { date: "2026-10-01", text: "next month" }, { text: "undated" }],
    mistakes: [{ date: "2026-09-02", what: "Charged twice; refunded.", refundTx: tx(77) }, { date: "2026-08-30", what: "old" }],
  }));
  process.env.REPORT_NOTES_PATH = path.join(dir, "notes.json");
  process.env.REPORT_INTEGRATIONS_DIR = path.join(dir, "none");
});

describe("generateMonthlyReport", () => {
  it("rolls up stored + regenerated daily reports, EDD outcomes, incidents and uptime for the month", async () => {
    await seed();
    await publishReport("2026-09-02", { now: to + 1 }); // one stored daily report; the rest regenerate on the fly
    const { report, markdown } = await generateMonthlyReport(PERIOD, { now: to + 600 });
    expect(report.range).toEqual({ from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z", days: 30, daysElapsed: 30, final: true });
    expect(report.days).toHaveLength(30);
    expect(report.days[1]).toMatchObject({ date: "2026-09-02", stored: true, final: true, verdicts: 3, ticks: 1 });
    expect(report.days[1].hash).toMatch(/^0x/);
    expect(report.days[0]).toMatchObject({ date: "2026-09-01", stored: false, final: true, hash: null, ticks: 1 });
    expect(report.days[2].ticks).toBe(0);
    expect(report.days[5].ticks).toBeNull();
    expect(report.verdicts).toEqual({ total: 3, outside: 2, byTier: { LOW: 2, MEDIUM: 0, HIGH: 1 }, outsideByTier: { LOW: 1, MEDIUM: 0, HIGH: 1 }, addressesGraded: 1 });
    expect(report.outsidePayers).toEqual({ count: 1, paidCalls: 3, addresses: [OUTSIDE] });
    expect(report.revenue).toEqual({ usdcGross: 0.04, usdcRefunded: 0.01, usdcIn: 0.03, ownPaymentsUsdc: 0.05 });
    expect(report.edd).toEqual({ opened: 3, answered: 2, reviewed: 1, cleared: 1, stillHigh: 1, openAtEnd: 1 });
    expect(report.guarantees).toEqual({ available: false, count: 0, activeAtEnd: 0, usdcCovered: 0, claims: 0 });
    expect(report.payouts).toMatchObject({ count: 1, held: 1, heldUsdc: 10, simulated: 1 });
    expect(report.tierChanges).toEqual({ count: 1, up: 1, down: 0 });
    expect(report.uptime).toEqual({ daysWithTicks: 2, daysWithStats: 3, ticks: 2, share: 0.0667 });
    expect(report.incidents.mistakes).toEqual([{ date: "2026-09-02", what: "Charged twice; refunded.", refundTx: tx(77), refundTxUrl: `https://explorer.arc.network/tx/${tx(77)}` }]);
    expect(report.incidents.notes).toEqual([{ date: "2026-09-05", text: "Gas Station enabled." }]);
    expect(report.caveats.join(" ")).toMatch(/self-reported/);
    expect(markdown).toContain("# CompliR transparency report - 2026-09");
    expect(markdown).toMatch(/\| Verdicts issued \(outside \/ all\) \| 2 \/ 3 \|/);
    expect(markdown).toContain(`- [\`${OUTSIDE}\`](https://explorer.arc.network/address/${OUTSIDE})`);
    const html = renderMarkdownHtml(markdown);
    expect(html).toContain("<h2>Summary</h2>");
    expect((html.match(/<table class="table">/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("marks a running month, reads an optional guarantees table, rejects bad periods", async () => {
    await db().execute(`CREATE TABLE guarantees (id TEXT PRIMARY KEY, status TEXT, amount_usdc REAL, created_at INTEGER)`);
    await db().execute({ sql: `INSERT INTO guarantees VALUES ('g1','ACTIVE',100,?), ('g2','CLAIMED',50,?), ('g3','ACTIVE',1,?)`, args: [from + 10, from + 20, to + 10] });
    const { report } = await generateMonthlyReport(PERIOD, { now: from + 5 * 86_400 + 10 });
    expect(report.range.final).toBe(false);
    expect(report.range.daysElapsed).toBe(6);
    expect(report.days).toHaveLength(6);
    expect(report.guarantees).toEqual({ available: true, count: 2, activeAtEnd: 1, usdcCovered: 150, claims: 1 });
    expect(report.caveats.join(" ")).toMatch(/has not ended/);
    await expect(generateMonthlyReport("2026-13")).rejects.toThrow(/period/);
    await expect(generateMonthlyReport("2026-09-01")).rejects.toThrow(/period/);
  });
});

describe("publishMonthly", () => {
  it("signs (EIP-191 over keccak(canonical json)), appends a REPORT_MONTHLY ledger entry, idempotent once final", async () => {
    await seed();
    const r = await publishMonthly(PERIOD, { now: to + 1 });
    expect(r.created).toBe(true);
    expect(r.hash).toBe(hashCanonical(canonicalize(r.report)));
    const signer = privateKeyToAccount(process.env.ATTESTER_PRIVATE_KEY as `0x${string}`).address;
    expect(await verifyMessage({ address: signer, message: r.hash, signature: r.signature })).toBe(true);
    const entry = (await listDecisions({ limit: 3 })).find((d) => d.kind === "REPORT")!;
    expect(entry.id).toBe(r.ledgerId);
    expect(entry.payload).toMatchObject({ type: "REPORT_MONTHLY", period: PERIOD, hash: r.hash, counts: { verdicts: 3, outsidePayers: 1, usdcIn: 0.03 } });
    expect(r.markdown).toContain(`- Hash: \`${r.hash}\``);
    expect(hashCanonical(canonicalize((await getMonthly(PERIOD))!.report))).toBe(r.hash);
    const again = await publishMonthly(PERIOD, { now: to + 2 });
    expect(again.created).toBe(false); expect(again.hash).toBe(r.hash);
    const forced = await publishMonthly(PERIOD, { now: to + 3, force: true });
    expect(forced.created).toBe(true); expect(forced.ledgerId).not.toBe(r.ledgerId);
    expect(((await listDecisions({ limit: 1 }))[0].payload as { supersedes: string }).supersedes).toBe(r.ledgerId);
    expect((await listMonthlyPeriods()).map((x) => x.period)).toEqual([PERIOD]);
  });
});
