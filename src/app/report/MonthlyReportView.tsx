import Link from "next/link";
import { CopyButton } from "@/components/CopyButton";
import { MONTH_RE, getMonthly, latestMonthly, listMonthlyPeriods, renderMarkdownHtml } from "@/lib/reports";
import styles from "./page.module.css";

/** /report?period=month[&date=YYYY-MM] - the monthly transparency rollup, same layout as the daily view. */
export async function MonthlyReportView({ month }: { month?: string }) {
  const wanted = month && MONTH_RE.test(month) ? month : null;
  const [report, archive] = await Promise.all([wanted ? getMonthly(wanted) : latestMonthly(), listMonthlyPeriods(120)]);

  return (
    <div className="container">
      <nav className={styles.periodSwitch} aria-label="Report period">
        <Link href="/report">Daily</Link>
        <Link href="/report?period=month" aria-current="page" className={styles.periodOn}>Monthly</Link>
      </nav>
      <div className="pageHead">
        <div>
          <p className="kicker">company · monthly transparency report · signed</p>
          <h1>Transparency report</h1>
          <p className="muted">
            One signed rollup per calendar month: verdicts, outside payers, revenue and refunds, EDD outcomes, guarantees, payouts, tier changes, incidents and tailer uptime. Built from the signed daily reports and the risk dataset.
          </p>
        </div>
        <span className="muted small">
          API: <code>/api/v1/report/monthly/&lt;yyyy-mm&gt;</code> · <code>.md</code>
        </span>
      </div>

      {!report && (
        <div className="alert alertInfo">
          {wanted ? <>No monthly report for <code>{wanted}</code>. </> : <>No monthly report published yet. </>}
          The agent closes a month on the first daily run after it ends (<code>POST /api/internal/report?period=month</code>).
          {archive.length > 0 && <> Latest: <Link href="/report?period=month">{archive[0].period}</Link>.</>}
        </div>
      )}

      {report && (
        <div className={styles.layout}>
          <article className={`card ${styles.doc}`} aria-label={`Monthly report ${report.period}`}>
            {!report.report.range.final && (
              <p className="alert alertInfo small" style={{ marginBottom: 12 }}>
                The month has not ended; this rollup is regenerated on every publish until it is final.
              </p>
            )}
            <div dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(report.markdown) }} />
          </article>

          <aside className={styles.side}>
            <div className="card">
              <h3 style={{ marginBottom: 8 }}>Share</h3>
              <div className={styles.actions}>
                <CopyButton text={report.markdown} label="Copy markdown" />
                <a className="btn btnSmall" href={`/api/v1/report/monthly/${report.period}.md`} target="_blank" rel="noopener noreferrer">Raw .md</a>
                <a className="btn btnSmall" href={`/api/v1/report/monthly/${report.period}`} target="_blank" rel="noopener noreferrer">JSON</a>
              </div>
            </div>
            <div className="card">
              <h3>Signature</h3>
              <dl className={styles.sig}>
                <dt>Period</dt>
                <dd>{report.period}{report.report.range.final ? " (final)" : " (running)"}</dd>
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
            </div>
            <div className="card">
              <h3>Months</h3>
              {archive.length === 0 ? <p className="muted small">No monthly reports yet.</p> : (
                <ul className={styles.archive}>
                  {archive.map((a) => (
                    <li key={a.period}>
                      <Link href={`/report?period=month&date=${a.period}`} aria-current={a.period === report.period ? "page" : undefined}>
                        {a.period === report.period ? <strong>{a.period}</strong> : a.period}
                      </Link>
                      <span className="muted small">{a.final ? "final" : "running"} · <a href={`/api/v1/report/monthly/${a.period}.md`}>.md</a></span>
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
