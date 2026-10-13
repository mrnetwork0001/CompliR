/**
 * Report → Markdown (what gets pasted into Discord #share-your-traction) and a tiny Markdown → HTML renderer for
 * /report (headings, tables, lists, paragraphs, **bold**, `code`, [links](url)). No dependencies, everything escaped.
 */
import type { DailyReport } from "./generate";

export interface SignatureBlock { hash: `0x${string}`; signature: `0x${string}`; signer: string; ledgerId: string | null }

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""));
const code = (s: string) => `\`${s}\``;
const short = (h: string, head = 10, tail = 6) => (h.length > head + tail + 2 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h);
const link = (text: string, url: string | null) => (url ? `[${text}](${url})` : text);
const row = (cells: (string | number)[]) => `| ${cells.map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`;
const table = (head: string[], rows: (string | number)[][]) => [row(head), `|${head.map(() => "---").join("|")}|`, ...rows.map(row)].join("\n");

export function renderReportMarkdown(r: DailyReport, sig?: SignatureBlock): string {
  const chainName = r.chain.chainId === 5042 ? "Arc mainnet" : r.chain.chainId === 5042002 ? "Arc testnet" : `chain ${r.chain.chainId}`;
  const out: string[] = [];
  out.push(`# CompliR traction report - ${r.date}`);
  out.push(`_Written and signed by the CompliR agent at ${r.generatedAt}. Period ${r.period.from} → ${r.period.to} (UTC)${r.period.final ? "" : ", **not final yet**"}. ${chainName}, USDC ${code(r.chain.usdc)}._`);
  out.push("");
  out.push("## Summary");
  out.push(table(["Metric", "Value"], [
    ["Outside payers", r.totals.outsidePayers],
    ["Paid calls (outside)", r.totals.paidCalls],
    ["USDC in (outside, net of refunds)", fmt(r.totals.usdcIn)],
    ["USDC refunded", fmt(r.totals.usdcRefunded)],
    ["Screenings outside / all", `${r.screenings.outside} / ${r.screenings.total}`],
    ["HIGH / MEDIUM / LOW (outside)", `${r.screenings.outsideByTier.HIGH} / ${r.screenings.outsideByTier.MEDIUM} / ${r.screenings.outsideByTier.LOW}`],
    ["Watches new / active", `${r.watches.created} / ${r.watches.active}`],
    ["Tier changes", r.tierChanges.count],
    ["Payouts paid / limited / held", `${r.payouts.paid} / ${r.payouts.limited} / ${r.payouts.held}${r.payouts.simulated ? ` (${r.payouts.simulated} simulated)` : ""}`],
    ["Refunds (sent / still owed USDC)", `${r.refunds.count} (${fmt(r.refunds.sentUsdc)} / ${fmt(r.refunds.owedUsdc)})`],
    ["Mistakes logged", r.mistakes.length],
  ]));
  out.push("");
  out.push("## Outside payers");
  out.push(r.outsidePayers.length
    ? table(["Payer", "Calls", "USDC", "Refunded", "First tx", "Endpoints"], r.outsidePayers.map((p) => [
        link(code(p.address), p.addressUrl), p.calls, fmt(p.usdcPaid), fmt(p.usdcRefunded), p.firstTx ? link(short(p.firstTx), p.firstTxUrl) : "-", p.endpoints.join(", "),
      ]))
    : "_No outside payers in this period._");
  out.push("");
  out.push("## Own wallets excluded");
  out.push(`${r.excluded.ownWallets.length} own wallet(s)${r.excluded.ownWallets.length ? `: ${r.excluded.ownWallets.map(code).join(", ")}` : ""} and ${r.excluded.internalClientIds.length} internal client id(s) (${r.excluded.internalClientIds.join(", ")}). Excluded from the counts above: ${r.excluded.ownPayments} payment(s) worth ${fmt(r.excluded.ownPaymentsUsdc)} USDC and ${r.excluded.ownScreenings} screening(s).`);
  out.push("");
  out.push("## Mistakes & refunds");
  if (r.refunds.items.length) {
    out.push(table(["Queued", "Payer", "USDC", "Reason", "Original tx", "Refund tx", "Status"], r.refunds.items.map((x) => [
      x.queuedAt.slice(0, 16).replace("T", " "), code(short(x.payer, 6, 4)), fmt(x.amountUsdc), x.reason,
      x.originalTx ? link(short(x.originalTx), x.originalTxUrl) : "-", x.refundTx ? link(short(x.refundTx), x.refundTxUrl) : "-", x.status,
    ])));
  } else out.push("_No refunds in this period._");
  if (r.mistakes.length) {
    out.push("");
    for (const m of r.mistakes) out.push(`- ${m.what}${m.refundTx ? ` - refund ${link(short(m.refundTx), m.refundTxUrl ?? null)}` : ""}`);
  }
  out.push("");
  out.push("## Integration PRs");
  out.push(r.integrations.length
    ? table(["Integration", "Repo", "Status", "PR"], r.integrations.map((i) => [i.name, i.repo ?? "-", i.status, i.pr ? link("PR", i.pr) : "-"]))
    : "_None._");
  if (r.tierChanges.items.length) {
    out.push("");
    out.push("## Tier changes");
    out.push(table(["Address", "From", "To", "Decision"], r.tierChanges.items.map((t) => [code(t.address), t.from ?? "-", t.to, t.decisionId ? link(t.decisionId, `/log/${t.decisionId}`) : "-"])));
  }
  if (r.notes.length) {
    out.push("");
    out.push("## Notes");
    for (const n of r.notes) out.push(`- ${n}`);
  }
  out.push("");
  out.push("## Caveats");
  for (const c of r.caveats) out.push(`- ${c}`);
  out.push("");
  out.push("## Verify");
  out.push(`- Ledger head at generation: seq ${r.ledger.lastSeq}${r.ledger.headHash ? `, ${code(r.ledger.headHash)}` : ""}`);
  out.push(`- JSON: ${code(`/api/v1/report/${r.date}`)} · Markdown: ${code(`/api/v1/report/${r.date}.md`)}`);
  if (sig) {
    out.push(`- Hash: ${code(sig.hash)} (keccak256 of the canonical JSON, signature and markdown excluded)`);
    out.push(`- Signer: ${code(sig.signer)} (CompliR attester) · Signature (EIP-191 personal_sign over the hash string): ${code(sig.signature)}`);
    if (sig.ledgerId) out.push(`- Ledger entry: ${link(sig.ledgerId, `/log/${sig.ledgerId}`)}`);
    out.push(`- Check: \`verifyMessage({ address: "${sig.signer}", message: "${sig.hash}", signature })\` (viem)`);
  }
  return out.join("\n") + "\n";
}

// ─── Markdown → HTML ─────────────────────────────────────────────────────────
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const SAFE_HREF = /^(https?:\/\/|\/(?!\/)|#)/;

/** Inline: `code`, **bold**, _italic_ (whole-segment), [text](url). Input is escaped first. */
export function renderInline(raw: string): string {
  const text = escapeHtml(raw);
  const parts: string[] = [];
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    parts.push(text.slice(last, m.index));
    if (m[1] !== undefined) parts.push(`<code>${m[1]}</code>`);
    else if (m[2] !== undefined) {
      const href = m[3].replace(/&amp;/g, "&");
      const inner = renderInline(m[2].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\""));
      parts.push(SAFE_HREF.test(href) ? `<a href="${escapeHtml(href)}"${/^https?:/.test(href) ? ` target="_blank" rel="noopener noreferrer"` : ""}>${inner}</a>` : inner);
    } else if (m[4] !== undefined) parts.push(`<strong>${m[4]}</strong>`);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts.join("");
}
const splitRow = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
const isSep = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

export function renderMarkdownHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  const para: string[] = [];
  const flush = () => { if (para.length) { out.push(`<p>${renderInline(para.join(" "))}</p>`); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); out.push(`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (line.trim().startsWith("|") && i + 1 < lines.length && isSep(lines[i + 1])) {
      flush();
      const head = splitRow(line); i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { rows.push(splitRow(lines[i])); i++; }
      out.push(`<div class="tableWrap"><table class="table"><thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td>${renderInline(r[k] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
      out.push(`<ul>${items.map((x) => `<li>${renderInline(x)}</li>`).join("")}</ul>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const em = /^_(.+)_$/.exec(line.trim());
    if (em) { flush(); out.push(`<p><em>${renderInline(em[1])}</em></p>`); i++; continue; }
    para.push(line.trim()); i++;
  }
  flush();
  return out.join("\n");
}
