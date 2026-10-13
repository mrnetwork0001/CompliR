import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Fig } from "@/components/figures/Fig";
import { CSV_COLUMNS, listDailyStats, type StoredStats } from "@/lib/stats";
import { StripChart, type StripPoint } from "./StripChart";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Risk dataset",
  description: "Public Arc risk dataset: one signed row per UTC day - addresses graded, tier mix, observed USDC volume and the share that touched a flagged wallet, reason codes, tier changes. JSON + CSV.",
};

type Props = { searchParams: Promise<{ date?: string }> };

const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d });
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function stripPoints(rows: StoredStats[], end: string, days = 30): StripPoint[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out: StripPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(end, -i);
    const r = byDate.get(date);
    out.push({ date, graded: r ? r.stats.graded.addresses : null, flaggedShare: r ? r.stats.volume.flaggedShare : null, volumeUsdc: r ? r.stats.volume.usdc : null, final: r ? r.stats.period.final : false });
  }
  return out;
}

export default async function StatsPage({ searchParams }: Props) {
  await connection();
  const { date } = await searchParams;
  const wanted = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  const all = await listDailyStats(365);
  const row = wanted ? all.find((r) => r.date === wanted) ?? null : all[0] ?? null;
  const end = row?.date ?? all[0]?.date ?? new Date().toISOString().slice(0, 10);
  const points = stripPoints(all, end);
  const s = row?.stats ?? null;
  const tiers = ["LOW", "MEDIUM", "HIGH"] as const;

  return (
    <div className="container">
      <div className="pageHead">
        <div>
          <p className="kicker">records · risk dataset · GET /api/v1/stats</p>
          <h1>Arc risk pulse</h1>
          <p className="muted">
            One signed row per UTC day, computed from what the CompliR tailer observed and what clients asked us to screen. Open data for analysts: JSON per day, a flat CSV, and an attester signature over every row.
          </p>
        </div>
        <span className="muted small">
          API: <code>/api/v1/stats</code> · <code>/api/v1/stats/&lt;date&gt;.json</code> · <code>/api/v1/stats/latest.csv</code>
        </span>
      </div>

      {!s && (
        <div className="alert alertInfo">
          {wanted ? <>No row for <code>{wanted}</code>. </> : <>No rows yet. </>}
          The agent computes today&apos;s row at 00:10 UTC and on demand (<code>POST /api/internal/stats</code>).
          {all.length > 0 && <> Latest: <Link href="/stats">{all[0].date}</Link>.</>}
        </div>
      )}

      {s && (
        <div className={styles.layout}>
          <div className={styles.main}>
            <p className={styles.headline}>
              {s.volume.edges > 0 ? (
                <><b>{pct(s.volume.flaggedShare)}</b> of observed USDC volume touched a flagged wallet {s.period.final ? `on ${s.date}` : "today"}.</>
              ) : (
                <>No USDC transfers observed {s.period.final ? `on ${s.date}` : "today"} yet; <b>{s.graded.addresses}</b> address{s.graded.addresses === 1 ? "" : "es"} graded.</>
              )}
            </p>

            <div className="stats" aria-label={`Day ${s.date}`}>
              <div className="stat"><span className="stat-label">Addresses graded</span><span className="stat-value">{fmt(s.graded.addresses)}<span className="stat-unit">/ {fmt(s.graded.screenings)} screens</span></span><span className="stat-sub">H {s.graded.byTier.HIGH} · M {s.graded.byTier.MEDIUM} · L {s.graded.byTier.LOW}</span></div>
              <div className="stat"><span className="stat-label">Observed wallets</span><span className="stat-value">{fmt(s.observed.wallets)}</span><span className="stat-sub">{fmt(s.observed.nodesNow)} graded · {fmt(s.observed.candidatesNow)} candidates on map</span></div>
              <div className="stat"><span className="stat-label">USDC observed</span><span className="stat-value">{fmt(s.volume.usdc, 2)}<span className="stat-unit">USDC</span></span><span className="stat-sub">{fmt(s.volume.edges)} transfers in the map window</span></div>
              <div className="stat"><span className="stat-label">Flagged share</span><span className="stat-value">{pct(s.volume.flaggedShare)}</span><span className="stat-sub">{fmt(s.volume.flaggedUsdc, 2)} USDC · {s.volume.flaggedEdges} transfers · {s.volume.flaggedWalletsNow} flagged wallets</span></div>
              <div className="stat"><span className="stat-label">Tier changes</span><span className="stat-value">{fmt(s.tierChanges.total)}</span><span className="stat-sub">{s.tierChanges.up} up · {s.tierChanges.down} down · map {s.tierChanges.map} / watch {s.tierChanges.watch}</span></div>
              <div className="stat"><span className="stat-label">Tailer ticks</span><span className="stat-value">{fmt(s.tailer.ticks)}<span className="stat-unit">/ day</span></span><span className="stat-sub">{s.tailer.lastTickAt ? `last ${s.tailer.lastTickAt.slice(11, 16)} UTC` : "no tick recorded"}{s.tailer.cursorBlock != null ? ` · block ${fmt(s.tailer.cursorBlock)}` : ""}</span></div>
            </div>

            <Fig n="01" label="30-day strip" meta={`${points[0].date} → ${points[points.length - 1].date} · UTC days · ${all.filter((r) => r.date >= points[0].date && r.date <= end).length} rows`} className={styles.fig}>
              <StripChart points={points} />
              <div className={styles.legend}>
                <span>addresses graded per day</span>
                <span className={styles.partial}>partial day (still recomputed)</span>
                <span className={styles.acc}>flagged share of observed USDC volume</span>
              </div>
            </Fig>

            <Fig n="02" label="Tier mix and reason codes" meta={`${s.date}${s.period.final ? " · final" : " · partial"}`} className={styles.fig}>
              <dl className={styles.mix}>
                {tiers.map((t) => (
                  <div key={t} style={{ display: "contents" }}>
                    <dt>{t}</dt>
                    <dd><span className={styles.mixBar} style={{ ["--tier-color" as string]: `var(--${t.toLowerCase()})` }}><i style={{ width: pct(s.graded.share[t], 1) }} /></span></dd>
                    <dd className={styles.mixN}>{s.graded.byTier[t]} · {pct(s.graded.share[t])}</dd>
                  </div>
                ))}
              </dl>
              <div className="tableWrap" style={{ marginTop: 14 }}>
                <table className={`table ${styles.reasons}`}>
                  <thead><tr><th>Reason code</th><th>Count</th><th>Share of screens</th></tr></thead>
                  <tbody>
                    {s.reasons.length === 0 ? (
                      <tr><td colSpan={3} className="muted">No screenings on this day.</td></tr>
                    ) : s.reasons.map((r) => (
                      <tr key={r.code}><td>{r.code}</td><td>{r.count}</td><td>{pct(r.share)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className={`muted small ${styles.tableNote}`}>
                Screens by client class: outside {s.clients.outside} · internal {s.clients.internal}{s.clients.unknown ? ` · unknown ${s.clients.unknown}` : ""} · {s.clients.distinctClientIds} client ids · {s.clients.outsidePayers} outside payers.
                {s.bridged.available ? ` Bridged inbound (CCTP): ${fmt(s.bridged.usdc, 2)} USDC in ${s.bridged.transfers} transfers, ${pct(s.bridged.flaggedShare)} to flagged wallets.` : " Bridged inbound (CCTP): not tracked on this deployment."}
              </p>
            </Fig>

            <Fig n="03" label="Caveats" meta="read before citing" className={styles.fig}>
              <ul className={styles.caveats}>
                {s.caveats.map((c) => <li key={c}>{c}</li>)}
                <li>Flagged = HIGH tier or a blocklist reason code (sanctions, USDC blacklist, protocol blocklist) at the time the row was computed; a later regrade changes later rows, not this one.</li>
                <li>Own wallets and internal client ids are excluded from the outside-payer counts; screenings they triggered are counted as internal.</li>
              </ul>
            </Fig>
          </div>

          <aside className={styles.side}>
            <section>
              <h3>Download</h3>
              <div className={styles.actions}>
                <a className="btn btnSmall" href={`/api/v1/stats/${s.date}.json`} target="_blank" rel="noopener noreferrer">Day JSON</a>
                <a className="btn btnSmall" href={`/api/v1/stats/${s.date}.csv`}>Day CSV</a>
                <Link className="btn btnSmall" href="/api/v1/stats?days=30" prefetch={false}>30-day JSON</Link>
                <a className="btn btnSmall btnPrimary" href="/api/v1/stats/latest.csv">All days CSV</a>
              </div>
              <p className="muted small" style={{ marginTop: 8 }}>CSV: one row per day, {CSV_COLUMNS.length} flat columns, newest first. Schema in <Link href="/docs">docs</Link> (<code>docs/DATASET.md</code>).</p>
            </section>

            <section>
              <h3>Signature</h3>
              <dl className={styles.sig}>
                <dt>Row</dt>
                <dd>{s.date}{s.period.final ? " (final)" : " (partial, will be recomputed)"}</dd>
                <dt>Hash (keccak256 of canonical JSON)</dt>
                <dd>{row!.hash}</dd>
                <dt>Signer (attester)</dt>
                <dd>{row!.signer}</dd>
                <dt>Signature (EIP-191)</dt>
                <dd>{row!.signature}</dd>
                <dt>Computed</dt>
                <dd>{new Date(row!.createdAt * 1000).toISOString()}</dd>
              </dl>
            </section>

            <section>
              <h3>How to verify</h3>
              <p className="muted small">Fetch the day, hash the <code>stats</code> object exactly as we do (sorted keys, no whitespace), and check the signature against the attester address.</p>
              <pre className={styles.verify}>{`import { keccak256, stringToHex, verifyMessage } from "viem";
const r = await (await fetch("/api/v1/stats/${s.date}.json")).json();
const canon = (v) => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]"
  : v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
  : JSON.stringify(v);
const hash = keccak256(stringToHex(canon(r.stats)));   // === r.hash
await verifyMessage({ address: r.signer, message: hash, signature: r.signature }); // true`}</pre>
            </section>

            <section>
              <h3>Archive</h3>
              <ul className={styles.archive}>
                {all.map((a) => (
                  <li key={a.date}>
                    <Link href={`/stats?date=${a.date}`} aria-current={a.date === s.date ? "page" : undefined}>{a.date === s.date ? <strong>{a.date}</strong> : a.date}</Link>
                    <span className="muted small">{a.stats.period.final ? "final" : "partial"} · {a.stats.graded.addresses} graded · <a href={`/api/v1/stats/${a.date}.json`}>.json</a></span>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}
