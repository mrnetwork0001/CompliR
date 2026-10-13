"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ShadowEntry, ShadowResponse } from "@/app/api/_lib/public-types";
import { ADDR_RE, HttpError, TX_RE, fmtUsdc, getHealth, postJson, short } from "./api";
import { HexLink } from "./HexLink";
import { TierBadge } from "./TierBadge";
import { CopyButton } from "./CopyButton";
import styles from "./ShadowReport.module.css";

/**
 * Example payee book (real addresses): a sanctioned wallet, our own wallets, and one lookalike of our wallet
 * (same first-4 + last-4 hex, different middle - the address-poisoning pattern).
 */
export const DEMO_BOOK = `Ronin Bridge exploiter (Lazarus Group - sanctioned),0x098b716b8aaf21512996dc57eb0615e2383e2f96
CompliR treasury wallet,0xc742ada2872a042dd36d2e706907b4036968960c
GuardedTreasury contract,0x5465f31a6155e3ecccc35f4e5bdc0e287763b0ee
CompliR treasury wallet (new invoice - lookalike),0xc7420000000000000000000000000000000a960c`;

export const DEMO_PAYMENTS = `0x098b716b8aaf21512996dc57eb0615e2383e2f96,150
0xc742ada2872a042dd36d2e706907b4036968960c,10`;

type Payee = { label: string; address: string };
type Payment = { to: string; amountUsdc: number; txHash?: string };

function parseJsonMaybe(text: string): unknown[] | null {
  const t = text.trim();
  if (!t.startsWith("[") && !t.startsWith("{")) return null;
  try {
    const j: unknown = JSON.parse(t);
    return Array.isArray(j) ? j : [j];
  } catch {
    return null;
  }
}

/** CSV (`label,address`) or JSON lines / JSON array of `{label,address}`. */
export function parsePayeeBook(text: string): { payees: Payee[]; errors: string[] } {
  const payees: Payee[] = [];
  const errors: string[] = [];
  const asJson = parseJsonMaybe(text);
  const rows: unknown[] = asJson ?? text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  rows.forEach((row, i) => {
    let label = "";
    let address = "";
    if (typeof row === "string") {
      const j = row.startsWith("{") ? parseJsonMaybe(row)?.[0] : null;
      if (j && typeof j === "object") {
        label = String((j as { label?: unknown }).label ?? "");
        address = String((j as { address?: unknown }).address ?? "");
      } else {
        const parts = row.split(/[,\t;]/).map((p) => p.trim().replace(/^"|"$/g, ""));
        if (parts.length === 1) {
          address = parts[0];
          label = `payee ${i + 1}`;
        } else {
          const ai = parts.findIndex((p) => ADDR_RE.test(p));
          address = ai >= 0 ? parts[ai] : parts[1];
          label = parts.filter((_, k) => k !== ai).join(" ").trim() || `payee ${i + 1}`;
        }
      }
    } else if (row && typeof row === "object") {
      label = String((row as { label?: unknown }).label ?? `payee ${i + 1}`);
      address = String((row as { address?: unknown }).address ?? "");
    }
    if (row === "label,address" || label.toLowerCase() === "label") return; // header row
    if (!ADDR_RE.test(address)) {
      errors.push(`line ${i + 1}: "${address || row}" is not an address`);
      return;
    }
    payees.push({ label: label.slice(0, 80) || `payee ${i + 1}`, address: address.toLowerCase() });
  });
  return { payees, errors };
}

/** CSV (`to,amountUsdc[,txHash]`) or JSON lines / array of `{to,amountUsdc,txHash?}`. */
export function parsePayments(text: string): { payments: Payment[]; errors: string[] } {
  const payments: Payment[] = [];
  const errors: string[] = [];
  const asJson = parseJsonMaybe(text);
  const rows: unknown[] = asJson ?? text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  rows.forEach((row, i) => {
    let to = "";
    let amount = NaN;
    let txHash: string | undefined;
    if (typeof row === "string") {
      const j = row.startsWith("{") ? parseJsonMaybe(row)?.[0] : null;
      if (j && typeof j === "object") {
        const o = j as { to?: unknown; amountUsdc?: unknown; txHash?: unknown };
        to = String(o.to ?? "");
        amount = Number(o.amountUsdc);
        if (typeof o.txHash === "string") txHash = o.txHash;
      } else {
        const parts = row.split(/[,\t;]/).map((p) => p.trim());
        if (parts[0]?.toLowerCase() === "to") return; // header
        to = parts[0] ?? "";
        amount = Number(parts[1]);
        if (parts[2] && TX_RE.test(parts[2])) txHash = parts[2];
      }
    } else if (row && typeof row === "object") {
      const o = row as { to?: unknown; amountUsdc?: unknown; txHash?: unknown };
      to = String(o.to ?? "");
      amount = Number(o.amountUsdc);
      if (typeof o.txHash === "string") txHash = o.txHash;
    }
    if (!ADDR_RE.test(to)) {
      errors.push(`payment ${i + 1}: "${to}" is not an address`);
      return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      errors.push(`payment ${i + 1}: amount "${amount}" is not a non-negative number`);
      return;
    }
    payments.push({ to: to.toLowerCase(), amountUsdc: amount, ...(txHash ? { txHash } : {}) });
  });
  return { payments, errors };
}

const mask = (a: string) => short(a, 6, 4);

/** The Markdown people paste into Discord. */
export function reportMarkdown(r: ShadowResponse, labels: Map<string, string>, origin: string): string {
  const s = r.summary;
  const lines: string[] = [];
  lines.push(`**CompliR shadow report** - ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`);
  lines.push(`Screened **${s.screened}** · would hold **${s.wouldHold}** · would limit **${s.wouldLimit}** · lookalikes **${s.lookalikes}**`);
  lines.push("");
  lines.push("| Payee | Address | Score | Tier | Action | Reasons |");
  lines.push("|---|---|---:|---|---|---|");
  for (const e of r.entries) {
    const action = e.wouldHold ? "HOLD" : e.wouldLimit ? "LIMIT" : "pay";
    lines.push(`| ${e.label.replace(/\|/g, "/")} | \`${mask(e.address)}\` | ${e.score} | ${e.tier} | ${action} | ${e.reasonCodes.join(", ") || "-"} |`);
  }
  if (r.paymentsAtRisk.length) {
    lines.push("");
    lines.push(`**Payments at risk (${r.paymentsAtRisk.length})**`);
    for (const p of r.paymentsAtRisk) {
      const label = labels.get(p.to) ?? "(unlisted)";
      lines.push(`- ${fmtUsdc(p.amountUsdc)} → ${label} \`${mask(p.to)}\`${p.txHash ? ` (tx \`${short(p.txHash, 10, 6)}\`)` : ""}`);
    }
  }
  lines.push("");
  lines.push(`Signed, replayable verdicts: ${origin}/shadow · attestations: ${origin}/api/v1/attestation/<address>`);
  return lines.join("\n");
}

type S = { status: "idle" } | { status: "loading"; n: number } | { status: "done"; r: ShadowResponse } | { status: "error"; message: string };

export function ShadowReport() {
  const [book, setBook] = useState(DEMO_BOOK);
  const [payments, setPayments] = useState(DEMO_PAYMENTS);
  const [s, setS] = useState<S>({ status: "idle" });
  const [explorerUrl, setExplorerUrl] = useState("");
  const [origin] = useState(() => (typeof window !== "undefined" ? window.location.origin : ""));

  useEffect(() => {
    let alive = true;
    getHealth().then((h) => alive && setExplorerUrl(h.network.explorerUrl ?? ""));
    return () => {
      alive = false;
    };
  }, []);

  const parsedBook = useMemo(() => parsePayeeBook(book), [book]);
  const parsedPay = useMemo(() => parsePayments(payments), [payments]);
  const labels = useMemo(() => new Map(parsedBook.payees.map((p) => [p.address, p.label])), [parsedBook]);
  const problems = [...parsedBook.errors, ...parsedPay.errors];

  async function run() {
    if (parsedBook.payees.length === 0) {
      setS({ status: "error", message: "Add at least one payee (label,address per line)." });
      return;
    }
    setS({ status: "loading", n: parsedBook.payees.length });
    try {
      const body = { payeeBook: parsedBook.payees, ...(parsedPay.payments.length ? { recentPayments: parsedPay.payments } : {}) };
      const r = await postJson<ShadowResponse>("/api/v1/shadow", body);
      setS({ status: "done", r });
    } catch (e) {
      setS({ status: "error", message: e instanceof HttpError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e) });
    }
  }

  const r = s.status === "done" ? s.r : null;

  return (
    <div className={`container ${styles.page}`}>
      <div className="pageHead">
        <div>
          <p className="kicker">oracle · shadow · POST /api/v1/shadow</p>
          <h1>Shadow Report</h1>
          <p className="muted">
            What your denylist would have missed. Paste your payee book and recent payments; CompliR screens every address (depth 1, max 50) and reports what it
            would have held or limited. Free during the event. Nothing is stored beyond the normal decision log.
          </p>
        </div>
      </div>

      <div className={`card ${styles.form}`}>
        <div className={styles.inputs}>
          <label className={styles.field}>
            <span>Payee book <span className="muted">CSV <code>label,address</code> or JSON lines</span></span>
            <textarea className={`input mono ${styles.ta}`} value={book} onChange={(e) => setBook(e.target.value)} rows={7} spellCheck={false} />
            <span className="muted small">{parsedBook.payees.length} payees parsed</span>
          </label>
          <label className={styles.field}>
            <span>Recent payments <span className="muted">optional · <code>to,amountUsdc,txHash?</code></span></span>
            <textarea className={`input mono ${styles.ta}`} value={payments} onChange={(e) => setPayments(e.target.value)} rows={7} spellCheck={false} />
            <span className="muted small">{parsedPay.payments.length} payments parsed</span>
          </label>
        </div>
        {problems.length > 0 && (
          <ul className={`alert alertError ${styles.problems}`}>
            {problems.slice(0, 6).map((p) => (
              <li key={p}>{p}</li>
            ))}
            {problems.length > 6 && <li>…and {problems.length - 6} more</li>}
          </ul>
        )}
        <div className={styles.actions}>
          <button type="button" className="btn btnPrimary" onClick={run} disabled={s.status === "loading"}>
            {s.status === "loading" ? `Screening ${s.n} addresses…` : "Run shadow report"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setBook(DEMO_BOOK);
              setPayments(DEMO_PAYMENTS);
            }}
          >
            Reset demo book
          </button>
          <span className="muted small">The demo book includes a lookalike of …cafe: same first and last four hex characters, different middle.</span>
        </div>
      </div>

      {s.status === "error" && (
        <div className="alert alertError" role="alert">
          <strong>Shadow report failed.</strong> {s.message}
        </div>
      )}

      {s.status === "loading" && (
        <div className={`card ${styles.loading}`} aria-busy="true">
          <span className="skeleton" style={{ width: "40%" }} />
          <span className="skeleton" />
          <span className="skeleton" style={{ width: "70%" }} />
        </div>
      )}

      {r && (
        <>
          <div className={styles.summary}>
            <Stat label="Screened" value={r.summary.screened} />
            <Stat label="Would hold" value={r.summary.wouldHold} tone="HIGH" />
            <Stat label="Would limit" value={r.summary.wouldLimit} tone="MEDIUM" />
            <Stat label="Lookalikes" value={r.summary.lookalikes} tone={r.summary.lookalikes ? "HIGH" : undefined} />
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div className={styles.tableHead}>
              <h3>Payees</h3>
              <CopyButton text={reportMarkdown(r, labels, origin)} label="Copy report as Markdown" />
            </div>
            <div className="tableWrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Payee</th>
                    <th>Address</th>
                    <th>Score</th>
                    <th>Tier</th>
                    <th>Action</th>
                    <th>Reasons</th>
                  </tr>
                </thead>
                <tbody>
                  {r.entries.map((e) => (
                    <Row key={e.address} e={e} explorerUrl={explorerUrl} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <section className="card">
            <h3>Payments at risk</h3>
            {r.paymentsAtRisk.length === 0 ? (
              <p className="muted small">None: every recent payment went to a LOW-tier address.</p>
            ) : (
              <ul className={styles.risk}>
                {r.paymentsAtRisk.map((p, i) => (
                  <li key={`${p.to}-${i}`}>
                    <strong>{fmtUsdc(p.amountUsdc)}</strong> → {labels.get(p.to) ?? "(unlisted recipient)"} <HexLink value={p.to} explorerUrl={explorerUrl} />
                    {p.txHash && (
                      <>
                        {" "}· tx <HexLink value={p.txHash} explorerUrl={explorerUrl} />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="muted small">
            Each row is a real verdict with a signed attestation. Open any address in the <Link href="/explorer">Explorer</Link> for the dial, funder graph and evidence.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "HIGH" | "MEDIUM" }) {
  return (
    <div className={`card ${styles.stat} ${tone === "HIGH" && value > 0 ? styles.statHigh : tone === "MEDIUM" && value > 0 ? styles.statMedium : ""}`}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

function Row({ e, explorerUrl }: { e: ShadowEntry; explorerUrl: string }) {
  return (
    <tr>
      <td className={styles.label}>{e.label}</td>
      <td>
        <Link href={`/explorer?address=${e.address}`} className="mono" title={e.address}>{mask(e.address)}</Link>
        {explorerUrl && (
          <>
            {" "}
            <span className="muted small"><HexLink value={e.address} explorerUrl={explorerUrl} /></span>
          </>
        )}
      </td>
      <td className="mono">{e.score}</td>
      <td><TierBadge tier={e.tier} size="sm" /></td>
      <td>{e.wouldHold ? <span className="badge badgeHIGH">HOLD</span> : e.wouldLimit ? <span className="badge badgeMEDIUM">LIMIT</span> : <span className="badge badgeLOW">pay</span>}</td>
      <td className={styles.codes}>{e.reasonCodes.length ? e.reasonCodes.map((c) => <code key={c}>{c}</code>) : <span className="muted">-</span>}</td>
    </tr>
  );
}
