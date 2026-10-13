import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { CopyButton } from "@/components/CopyButton";
import { getReport, latestReport, listReportDates, renderMarkdownHtml } from "@/lib/reports";
import { MonthlyReportView } from "./MonthlyReportView";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Traction report",
  description: "Daily traction report written and signed by the CompliR agent: outside payers with tx links, own wallets excluded, refunds and mistakes listed.",
};

type Props = { searchParams: Promise<{ date?: string; period?: string }> };

/** Daily | Monthly switch at the top of the page; the daily view below is unchanged. */
function PeriodSwitch({ period }: { period: "daily" | "monthly" }) {
  return (
    <nav className={styles.periodSwitch} aria-label="Report period">
      <Link href="/report" aria-current={period === "daily" ? "page" : undefined} className={period === "daily" ? styles.periodOn : undefined}>Daily</Link>
      <Link href="/report?period=month" aria-current={period === "monthly" ? "page" : undefined} className={period === "monthly" ? styles.periodOn : undefined}>Monthly</Link>
    </nav>
  );
}

export default async function ReportPage({ searchParams }: Props) {
  await connection();
  const { date, period } = await searchParams;
  if (period === "month" || period === "monthly") return <MonthlyReportView month={date} />;
  const wanted = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  const [report, archive] = await Promise.all([wanted ? getReport(wanted) : latestReport(), listReportDates(365)]);

  return (
    <div className="container">
      <PeriodSwitch period="daily" />
      <div className="pageHead">
        <div>
          <p className="kicker">company · daily report · signed</p>
          <h1>Traction report</h1>
          <p className="muted">
            Written and signed by the agent itself, once per UTC day. Own wallets excluded, every outside payer linked to a tx, refunds and mistakes listed. This is the text we paste into <code>#share-your-traction</code>.
          </p>
        </div>
        <span className="muted small">
          API: <code>/api/v1/report</code> · <code>/api/v1/report/&lt;date&gt;.md</code>
        </span>
      </div>

      {!report && (
        <div className="alert alertInfo">
          {wanted ? <>No report for <code>{wanted}</code>. </> : <>No report published yet. </>}
          The agent publishes the previous UTC day at 00:05 UTC (<code>worker/report.ts</code> or <code>POST /api/internal/report</code>).
          {archive.length > 0 && (
            <>
              {" "}Latest: <Link href="/report">{archive[0].date}</Link>.
            </>
          )}
        </div>
      )}

      {report && (
        <div className={styles.layout}>
          <article className={`card ${styles.doc}`} aria-label={`Report ${report.date}`}>
            {!report.report.period.final && (
              <p className="alert alertInfo small" style={{ marginBottom: 12 }}>
                Generated before the period ended; numbers may change until it is regenerated.
              </p>
            )}
            <div dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(report.markdown) }} />
          </article>

          <aside className={styles.side}>
            <div className="card">
              <h3 style={{ marginBottom: 8 }}>Share</h3>
              <div className={styles.actions}>
                <CopyButton text={report.markdown} label="Copy markdown" />
                <a className="btn btnSmall" href={`/api/v1/report/${report.date}.md`} target="_blank" rel="noopener noreferrer">Raw .md</a>
                <a className="btn btnSmall" href={`/api/v1/report/${report.date}`} target="_blank" rel="noopener noreferrer">JSON</a>
              </div>
              <p className="muted small" style={{ marginTop: 8 }}>
                The copied text is byte-identical to <code>/api/v1/report/{report.date}.md</code>.
              </p>
            </div>

            <div className="card">
              <h3>Signature</h3>
              <dl className={styles.sig}>
                <dt>Report date</dt>
                <dd>{report.date}{report.report.period.final ? " (final)" : " (partial)"}</dd>
                <dt>Hash (keccak256 of canonical JSON)</dt>
                <dd>{report.hash}</dd>
                <dt>Signer (attester)</dt>
                <dd>{report.signer}</dd>
                <dt>Signature (EIP-191)</dt>
                <dd>{report.signature}</dd>
                <dt>Ledger entry</dt>
                <dd>{report.ledgerId ? <Link href={`/log/${encodeURIComponent(report.ledgerId)}`}>{report.ledgerId}</Link> : "-"}</dd>
                <dt>Generated</dt>
                <dd>{new Date(report.createdAt * 1000).toISOString()}</dd>
              </dl>
              <p className="muted small" style={{ marginTop: 10 }}>
                Verify with viem: <code>verifyMessage({"{"} address, message: hash, signature {"}"})</code>. The ledger entry is on the hash chain and Merkle-anchored on Arc.
              </p>
            </div>

            <div className="card">
              <h3>Archive</h3>
              {archive.length === 0 ? (
                <p className="muted small">No reports yet.</p>
              ) : (
                <ul className={styles.archive}>
                  {archive.map((a) => (
                    <li key={a.date}>
                      <Link href={`/report?date=${a.date}`} aria-current={a.date === report.date ? "page" : undefined}>
                        {a.date === report.date ? <strong>{a.date}</strong> : a.date}
                      </Link>
                      <span className="muted small">{a.final ? "final" : "partial"} · <a href={`/api/v1/report/${a.date}.md`}>.md</a></span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
