import "../__tests__/setup";
process.env.ATTESTER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
process.env.OWN_WALLETS = "0x00000000000000000000000000000000000000aa,0x00000000000000000000000000000000000000BB";
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
import { __resetRefunds, queueRefund } from "../refunds";
import { __resetDb, db } from "../store/db";
import { recordPayment, recordScreening, upsertWatch } from "../store/repo";
import type { Verdict } from "../types";
import { __resetReports, generateDailyReport, getReport, latestReport, listReportDates, periodFor, publishReport, renderMarkdownHtml, renderReportMarkdown } from "./index";

const OUTSIDE = "0x857b06519e91e3a54538791bdbb0e22373e36b66";
const OUTSIDE2 = "0x1111111111111111111111111111111111111111";
const OWN = "0x00000000000000000000000000000000000000aa";
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const DATE = "2026-10-12";
const { from, to } = periodFor(DATE);
const inDay = from + 3600;

function verdict(tier: Verdict["tier"], subject: string): Verdict {
  return {
    address: subject as `0x${string}`, score: tier === "HIGH" ? 90 : tier === "MEDIUM" ? 40 : 5, tier, recommendedLimits: { maxPerTxUsdc: 1, maxPerDayUsdc: 2 }, reasons: [], rationale: "", eddRequested: [],
    nextRescreenAt: "", decisionId: "dec_x", screenedAt: "", evidence: {} as Verdict["evidence"],
    attestation: { typedData: { domain: { name: "CompliR", version: "1", chainId: 5042, verifyingContract: "0x" }, types: { Attestation: [] }, primaryType: "Attestation", message: { subject: subject as `0x${string}`, tier: 1, score: 1, decisionHash: "0x", issuedAt: inDay, validUntil: inDay + 10 } }, signature: "0x", attester: "0x", validUntil: inDay + 10, registryTx: null },
  };
}

async function seed() {
  const d = db();
  const ins = (p: { tx: string | null; payer: string; amt: number; ep: string; at: number; refunded?: number }) =>
    d.execute({ sql: `INSERT INTO payments (tx_hash, payer, amount_usdc, endpoint, refunded, created_at) VALUES (?,?,?,?,?,?)`, args: [p.tx, p.payer, p.amt, p.ep, p.refunded ?? 0, p.at] });
  await recordPayment({ txHash: tx(0), payer: OUTSIDE, amountUsdc: 0.01, endpoint: "/api/v1/screen" }); // today, outside the period
  await ins({ tx: tx(1), payer: OUTSIDE, amt: 0.01, ep: "/api/v1/screen", at: inDay });
  await ins({ tx: tx(2), payer: OUTSIDE, amt: 0.05, ep: "/api/v1/watch", at: inDay + 10 });
  await ins({ tx: tx(3), payer: OUTSIDE, amt: 0.01, ep: "/api/v1/screen", at: inDay + 20, refunded: 1 });
  await ins({ tx: tx(4), payer: OUTSIDE2, amt: 0.01, ep: "/api/v1/screen", at: inDay + 30 });
  await ins({ tx: tx(5), payer: OWN, amt: 0.01, ep: "/api/v1/screen", at: inDay + 40 });
  await ins({ tx: tx(6), payer: "0x00000000000000000000000000000000000000bb", amt: 0.02, ep: "/api/v1/screen", at: inDay + 50 });
  await ins({ tx: tx(7), payer: "web-explorer", amt: 0, ep: "/api/v1/screen", at: inDay + 60 });
  await recordScreening(verdict("HIGH", OUTSIDE2), "acme", "outside");
  await recordScreening(verdict("LOW", OUTSIDE2), "acme", "outside");
  await recordScreening(verdict("MEDIUM", OUTSIDE2), "web-explorer", "own");
  await d.execute({ sql: `UPDATE screenings SET created_at = ?`, args: [inDay] });
  await upsertWatch({ address: OUTSIDE2, webhookUrl: "https://x/hook", clientId: "acme" });
  await d.execute({ sql: `UPDATE watches SET created_at = ?, expires_at = ?`, args: [inDay, to + 86400 * 20] });
  await appendDecision({ kind: "TIER_CHANGE", subject: OUTSIDE2 as `0x${string}`, clientId: "watcher", payload: { from: "LOW", to: "HIGH", decisionId: "dec_tc" } });
  await appendDecision({ kind: "PAYOUT", subject: OUTSIDE2 as `0x${string}`, clientId: "treasury-agent", payload: { type: "PAYOUT", status: "LIMITED", paidUsdc: 50, heldUsdc: 70, simulated: true } });
  await appendDecision({ kind: "PAYOUT", subject: OUTSIDE2 as `0x${string}`, clientId: "treasury-agent", payload: { type: "PAYOUT", status: "HELD", paidUsdc: 0, heldUsdc: 10, simulated: true } });
  await d.execute({ sql: `UPDATE decisions SET created_at = ?`, args: [inDay + 5] });
  await queueRefund({ payer: OUTSIDE, amountUsdc: 0.01, reason: "handler failed after settle", originalTx: tx(3) });
  await d.execute({ sql: `UPDATE refunds SET created_at = ?`, args: [inDay + 25] });
}

beforeEach(() => {
  __resetDb(); __resetRefunds(); __resetReports(); __resetConfig();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const dir = mkdtempSync(path.join(tmpdir(), "complir-report-"));
  writeFileSync(path.join(dir, "notes.json"), JSON.stringify({
    notes: [{ date: DATE, text: "Shadow report sent to Steward." }, { date: "2020-01-01", text: "old" }, { text: "always" }],
    mistakes: [{ date: DATE, what: "Charged for a screen that timed out; auto-refunded.", refundTx: tx(77) }],
    integrations: { steward: { repo: "big14way/steward", status: "opened", pr: "https://github.com/big14way/steward/pull/1" }, extra: { status: "idea" } },
  }));
  process.env.REPORT_NOTES_PATH = path.join(dir, "notes.json");
  process.env.REPORT_INTEGRATIONS_DIR = path.join(process.cwd(), "docs", "integrations");
});

describe("generateDailyReport", () => {
  it("excludes own wallets + internal ids, lists outside payers with tx links, counts everything in the period", async () => {
    await seed();
    const { report, markdown } = await generateDailyReport(DATE, { now: to + 600 });
    expect(report.period).toEqual({ from: "2026-10-12T00:00:00.000Z", to: "2026-10-13T00:00:00.000Z", final: true });
    expect(report.totals).toEqual({ outsidePayers: 2, paidCalls: 4, usdcIn: 0.07, usdcGross: 0.08, usdcRefunded: 0.01 });
    expect(report.outsidePayers.map((p) => p.address)).toEqual([OUTSIDE, OUTSIDE2]);
    expect(report.outsidePayers[0]).toMatchObject({ calls: 3, usdcPaid: 0.06, usdcRefunded: 0.01, firstTx: tx(1), firstTxUrl: `https://explorer.arc.network/tx/${tx(1)}`, endpoints: ["/api/v1/screen", "/api/v1/watch"] });
    expect(JSON.stringify(report.outsidePayers)).not.toContain(OWN);
    expect(report.excluded).toEqual({ ownWallets: [OWN, "0x00000000000000000000000000000000000000bb"], internalClientIds: expect.arrayContaining(["web-explorer", "report"]), ownPayments: 3, ownPaymentsUsdc: 0.03, ownScreenings: 1 });
    expect(report.screenings).toEqual({ total: 3, outside: 2, byTier: { LOW: 1, MEDIUM: 1, HIGH: 1 }, outsideByTier: { LOW: 1, MEDIUM: 0, HIGH: 1 } });
    expect(report.watches).toEqual({ created: 1, active: 1 });
    expect(report.tierChanges).toEqual({ count: 1, items: [{ address: "0x1111…1111", from: "LOW", to: "HIGH", decisionId: "dec_tc" }] });
    expect(report.payouts).toMatchObject({ count: 2, paid: 0, limited: 1, held: 1, paidUsdc: 50, heldUsdc: 80, simulated: 2 });
    expect(report.refunds.count).toBe(1);
    expect(report.refunds.items[0]).toMatchObject({ payer: OUTSIDE, amountUsdc: 0.01, status: "QUEUED", originalTx: tx(3), originalTxUrl: `https://explorer.arc.network/tx/${tx(3)}`, refundTx: null });
    expect(report.refunds.owedUsdc).toBe(0.01);
    expect(report.notes).toEqual(["Shadow report sent to Steward.", "always"]);
    expect(report.mistakes).toEqual([{ date: DATE, what: "Charged for a screen that timed out; auto-refunded.", refundTx: tx(77), refundTxUrl: `https://explorer.arc.network/tx/${tx(77)}` }]);
    expect(report.integrations.find((i) => i.name === "steward")).toMatchObject({ status: "opened", pr: "https://github.com/big14way/steward/pull/1", notes: true });
    expect(report.integrations.find((i) => i.name === "vestiarion")).toMatchObject({ status: "prepared, not submitted", notes: true });
    expect(report.integrations.find((i) => i.name === "extra")).toMatchObject({ status: "idea", notes: false });
    expect(report.caveats.join(" ")).toMatch(/self-reported/);
    expect(report.signer).toBe(privateKeyToAccount(process.env.ATTESTER_PRIVATE_KEY as `0x${string}`).address.toLowerCase());
    expect(markdown).toContain(`| [\`${OUTSIDE}\`](https://explorer.arc.network/address/${OUTSIDE}) | 3 | 0.06 | 0.01 | [0x00000000…000001](https://explorer.arc.network/tx/${tx(1)}) | /api/v1/screen, /api/v1/watch |`);
    expect(markdown).not.toContain(OWN.slice(0, 20) + "`](");
    expect(markdown).toContain("## Mistakes & refunds");
  });

  it("flags a partial period", async () => {
    const { report } = await generateDailyReport(DATE, { now: from + 100 });
    expect(report.period.final).toBe(false);
    expect(report.caveats.join(" ")).toMatch(/before the period ended/);
    await expect(generateDailyReport("2026-13-40")).rejects.toThrow(/date/);
  });
});

describe("publishReport", () => {
  it("signs with the attester (EIP-191 over keccak(canonical json)), verifiable with viem; appends a REPORT ledger entry", async () => {
    await seed();
    const r = await publishReport(DATE, { now: to + 1 });
    expect(r.created).toBe(true);
    expect(r.hash).toBe(hashCanonical(canonicalize(r.report)));
    const signer = privateKeyToAccount(process.env.ATTESTER_PRIVATE_KEY as `0x${string}`).address;
    expect(r.signer).toBe(signer.toLowerCase());
    expect(await verifyMessage({ address: signer, message: r.hash, signature: r.signature })).toBe(true);
    expect(await verifyMessage({ address: signer, message: r.hash.replace(/.$/, "0"), signature: r.signature })).toBe(false);
    const entry = (await listDecisions({ limit: 3 })).find((d) => d.kind === "REPORT")!;
    expect(entry.id).toBe(r.ledgerId);
    expect(entry.payload).toMatchObject({ type: "REPORT", date: DATE, hash: r.hash, signature: r.signature, counts: { outsidePayers: 2, paidCalls: 4, usdcIn: 0.07, refunds: 1, mistakes: 1 } });
    expect(r.markdown).toContain(`- Hash: \`${r.hash}\``);
    expect(r.markdown).toContain(`- Ledger entry: [${r.ledgerId}](/log/${r.ledgerId})`);
    // stored JSON hashes the same (round-trip through the DB)
    const stored = (await getReport(DATE))!;
    expect(hashCanonical(canonicalize(stored.report))).toBe(r.hash);
  });

  it("is idempotent per date; force regenerates with a new ledger entry that supersedes the old one", async () => {
    const a = await publishReport(DATE);
    const b = await publishReport(DATE);
    expect(b.created).toBe(false);
    expect(b.hash).toBe(a.hash); expect(b.ledgerId).toBe(a.ledgerId);
    expect((await listDecisions({ limit: 10 })).filter((d) => d.kind === "REPORT")).toHaveLength(1);
    const c = await publishReport(DATE, { force: true });
    expect(c.created).toBe(true);
    expect(c.ledgerId).not.toBe(a.ledgerId);
    expect((await listDecisions({ limit: 10 })).filter((d) => d.kind === "REPORT")).toHaveLength(2);
    expect(((await listDecisions({ limit: 1 }))[0].payload as { supersedes: string }).supersedes).toBe(a.ledgerId);
    await publishReport("2026-10-11");
    expect((await latestReport())!.date).toBe(DATE);
    expect((await listReportDates()).map((x) => x.date)).toEqual([DATE, "2026-10-11"]);
  });
});

describe("markdown", () => {
  it("renders headings, a table, bold, code and safe links", () => {
    const html = renderMarkdownHtml(`# Title\n_sub **b**_\n\n## Outside payers\n| Payer | Calls | First tx |\n|---|---|---|\n| \`0xabc\` | 3 | [0x1…](https://explorer.arc.network/tx/0x1) |\n| <script>x</script> | 1 | [js](javascript:alert(1)) |\n\n- item **bold**\n- [ledger](/log/dec_1)\n\nplain para\n`);
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<p><em>sub <strong>b</strong></em></p>");
    expect(html).toContain(`<div class="tableWrap"><table class="table"><thead><tr><th>Payer</th><th>Calls</th><th>First tx</th></tr></thead>`);
    expect(html).toContain(`<td><code>0xabc</code></td><td>3</td><td><a href="https://explorer.arc.network/tx/0x1" target="_blank" rel="noopener noreferrer">0x1…</a></td>`);
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain(`<li><a href="/log/dec_1">ledger</a></li>`);
    expect(html).toContain("<p>plain para</p>");
  });
  it("report markdown has a summary table that the renderer turns into <table>", async () => {
    const { report } = await generateDailyReport(DATE, { now: to + 1 });
    const md = renderReportMarkdown(report, { hash: "0xh", signature: "0xs", signer: "0xa", ledgerId: "dec_1" });
    expect(md).toMatch(/\| Metric \| Value \|\n\|---\|---\|\n\| Outside payers \| 0 \|/);
    const html = renderMarkdownHtml(md);
    expect((html.match(/<table class="table">/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("<h2>Summary</h2>");
  });
});
