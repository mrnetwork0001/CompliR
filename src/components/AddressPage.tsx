"use client";

import { ScreeningRun } from "./ScreeningRun";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Verdict } from "@/lib/types";
import type { AddressHistory, HistoryVerdict } from "@/lib/check/history";
import type { CheckResponse } from "@/lib/check/plain";
import { HttpError, apiFetch, fmtRelative, fmtTime, fmtUsdc, postJson, short } from "./api";
import { Glyph, type GlyphName } from "./Glyph";
import { TierBadge } from "./TierBadge";
import { HexLink } from "./HexLink";
import { CopyButton } from "./CopyButton";
import { VerdictView } from "./VerdictView";
import styles from "./AddressPage.module.css";

interface NetworkResponse {
  heldElsewhere: { clients: number; lastAt: number | null };
  concentrationHint: { funder: string; otherPayees: number } | null;
  windowDays: number;
  events: { kind: string; eventName: string; simulated: boolean; txHash: string | null; tierFrom: string | null; tierTo: string | null; handledAt: string }[];
}

const noop = () => () => {};
/** false on the server and during hydration, true after mount: lets locale/relative times render without a hydration mismatch. */
const useMounted = () => useSyncExternalStore(noop, () => true, () => false);

/** A timestamp: UTC on the server, the viewer's locale after mount. `rel` renders the relative form instead. */
function Stamp({ iso, rel = false }: { iso: string; rel?: boolean }) {
  const mounted = useMounted();
  if (!mounted) return <>{rel ? `${iso.slice(0, 10)} UTC` : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`}</>;
  return <>{rel ? fmtRelative(iso) : fmtTime(iso)}</>;
}

const GLYPH: Record<"HIGH" | "MEDIUM" | "LOW", GlyphName> = { HIGH: "hold", MEDIUM: "limit", LOW: "check" };
const TONE: Record<"HIGH" | "MEDIUM" | "LOW", "high" | "medium" | "low"> = { HIGH: "high", MEDIUM: "medium", LOW: "low" };
const REQUESTER: Record<HistoryVerdict["requester"], string> = { own: "CompliR (own)", outside: "an integrator", unknown: "a visitor" };

/** Renders any JSON-ish object as a spec list; used for guarantee/CCTP fields whose shape another module owns. */
function Loose({ data }: { data: unknown }) {
  if (data == null) return null;
  if (typeof data !== "object") return <code className="break">{String(data)}</code>;
  const entries = Array.isArray(data) ? data.map((v, i) => [String(i), v] as const) : Object.entries(data as Record<string, unknown>);
  return (
    <dl className={`dl ${styles.loose}`}>
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className="mono break">{v != null && typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AddressPage({ history, explorerUrl, shareUrl }: { history: AddressHistory; explorerUrl: string; shareUrl: string }) {
  const router = useRouter();
  const h = history;
  const [latest, setLatest] = useState<CheckResponse | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string }>({ kind: "idle" });
  const [dev, setDev] = useState(false);
  const [network, setNetwork] = useState<NetworkResponse | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch<NetworkResponse>(`/api/v1/network/${h.address}`)
      .then((n) => alive && setNetwork(n))
      .catch(() => alive && setNetwork(null));
    return () => {
      alive = false;
    };
  }, [h.address]);

  const recheck = useCallback(async () => {
    setState({ kind: "busy" });
    try {
      const r = await postJson<CheckResponse>("/api/v1/check", { address: h.address, source: "address", full: true });
      setLatest(r);
      if (r.verdict) setVerdict(r.verdict);
      setState({ kind: "idle" });
      router.refresh();
    } catch (e) {
      setState({ kind: "error", message: e instanceof HttpError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e) });
    }
  }, [h.address, router]);

  const tier = latest?.tier ?? h.latest?.tier ?? null;
  const headline = latest?.headline ?? h.latest?.headline ?? "Not graded yet.";
  const advice = latest?.advice ?? h.latest?.advice ?? "CompliR has never screened this address. Run a check to grade it now.";
  const limits = latest?.limits ?? null;
  const screenedAt = latest?.screenedAt ?? h.latest?.screenedAt ?? null;
  const expired = !latest && !!h.latest?.expired;
  const busy = state.kind === "busy";
  const guarantee = latest?.guarantee ?? (verdict as (Verdict & { guarantee?: unknown }) | null)?.guarantee;
  const ev = verdict?.evidence as (Verdict["evidence"] & { cctp?: unknown; inbound?: unknown }) | undefined;
  const cctp = latest?.cctp ?? (verdict as (Verdict & { cctp?: unknown }) | null)?.cctp ?? ev?.cctp ?? ev?.inbound;
  const held = network?.heldElsewhere.clients ?? 0;

  return (
    <div className={`container ${styles.page}`}>
      <div className="pageHead">
        <div>
          <p className="kicker">oracle · address · GET /api/v1/address/{short(h.address, 6, 4)}</p>
          <h1 className={styles.headline} data-tier={tier ?? undefined}>
            {tier ? <Glyph name={GLYPH[tier]} tone={TONE[tier]} size={22} title={tier} style={{ marginRight: 12, verticalAlign: "-0.05em" }} /> : <Glyph name="dot" tone="muted" size={22} style={{ marginRight: 12 }} />}
            {headline}
          </h1>
          <p className={`muted ${styles.advice}`}>{advice}</p>
          <p className={styles.addr}>
            <HexLink value={h.address} explorerUrl={explorerUrl} full />
          </p>
        </div>
        <div className={styles.headRight}>
          <div className={styles.chips}>
            <TierBadge tier={tier ?? "UNKNOWN"} size="lg" />
            {expired && <span className="chip chip-warn">attestation expired</span>}
            {h.openEdd.length > 0 && <span className="chip chip-warn">EDD open</span>}
            {held > 0 && <span className="chip">held elsewhere · {held}</span>}
          </div>
          <div className={styles.headActions}>
            <CopyButton text={shareUrl} label="Share · copy link" />
            <button type="button" className="btn btnSmall btnPrimary" onClick={() => void recheck()} disabled={busy}>
              {busy ? "Checking…" : h.latest ? "Re-check now" : "Check now"}
            </button>
            <Link href={`/check?address=${h.address}`} className="btn btnSmall">Check another</Link>
          </div>
        </div>
      </div>

      {state.kind === "error" && (
        <div className="alert alertError" role="alert">
          {state.message}
        </div>
      )}
      {busy && <ScreeningRun address={h.address} />}

      <div className={`stats ${styles.stats}`}>
        <div className="stat">
          <div className="stat-label">score</div>
          <div className="stat-value">{latest?.score ?? h.latest?.score ?? "–"}<span className="stat-unit">/100</span></div>
          <div className="stat-sub">{screenedAt ? <>graded <Stamp iso={screenedAt} rel /></> : "never graded"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">max per tx</div>
          <div className="stat-value">{limits ? fmtUsdc(limits.maxPerTxUsdc).replace(" USDC", "") : tier === "HIGH" ? "0" : "–"}<span className="stat-unit">USDC</span></div>
          <div className="stat-sub">{limits ? `${fmtUsdc(limits.maxPerDayUsdc)} per day` : "re-check for limits"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">verdicts</div>
          <div className="stat-value">{h.counts.verdicts}</div>
          <div className="stat-sub">{h.counts.high} high · {h.counts.medium} medium · {h.counts.low} low</div>
        </div>
        <div className="stat">
          <div className="stat-label">tier changes</div>
          <div className="stat-value">{h.tierChanges.length}</div>
          <div className="stat-sub">{h.tierChanges[0] ? <>last <Stamp iso={h.tierChanges[0].at} rel /></> : "stable"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">network</div>
          <div className="stat-value">{network ? held : "–"}</div>
          <div className="stat-sub">{network ? `integrators held it · ${network.windowDays} d` : "signal loading"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">first seen</div>
          <div className="stat-value">{h.firstSeenAt ? h.firstSeenAt.slice(0, 10) : "–"}</div>
          <div className="stat-sub">{h.counts.outsideRequests} outside request{h.counts.outsideRequests === 1 ? "" : "s"}</div>
        </div>
      </div>

      {(guarantee != null || cctp != null || h.openEdd.length > 0 || (network && (network.concentrationHint || network.events.length > 0))) && (
        <section className={styles.signals}>
          {guarantee != null && (
            <div className={styles.signal}>
              <h3 className={styles.h}>Guarantee / bond</h3>
              <Loose data={guarantee} />
            </div>
          )}
          {cctp != null && (
            <div className={styles.signal}>
              <h3 className={styles.h}>Inbound CCTP flags</h3>
              <Loose data={cctp} />
            </div>
          )}
          {h.openEdd.length > 0 && (
            <div className={styles.signal}>
              <h3 className={styles.h}>Open due diligence</h3>
              <ul className={styles.list}>
                {h.openEdd.map((e) => (
                  <li key={e.id}>
                    <Link href={`/edd/${e.id}`} className="mono">{e.id}</Link> · {e.questions} question{e.questions === 1 ? "" : "s"} · opened <Stamp iso={e.createdAt} rel />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {network && (network.concentrationHint || network.events.length > 0) && (
            <div className={styles.signal}>
              <h3 className={styles.h}>Network signal</h3>
              {network.concentrationHint && (
                <p className="small">
                  A funder of this address, <HexLink value={network.concentrationHint.funder} explorerUrl={explorerUrl} />, also funded {network.concentrationHint.otherPayees} other graded wallets.
                </p>
              )}
              {network.events.length > 0 && (
                <ul className={styles.list}>
                  {network.events.map((e, i) => (
                    <li key={i}>
                      <code>{e.eventName}</code>{e.simulated ? " (drill)" : ""} · <Stamp iso={e.handledAt} />
                      {e.tierTo ? ` · ${e.tierFrom ?? "?"} → ${e.tierTo}` : ""}
                      {e.txHash ? <> · <HexLink value={e.txHash} explorerUrl={explorerUrl} /></> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      <section>
        <div className="sec-bar">
          <span className="sec-n">02</span>
          <span>Every verdict ever issued</span>
          <span className="sec-meta">newest first · requester shown as a class, never an id</span>
        </div>
        {h.verdicts.length === 0 ? (
          <p className="muted">No verdicts yet. The first check writes the first row here, signed and mirrored on Arc.</p>
        ) : (
          <ol className={styles.timeline}>
            {h.verdicts.map((v, i) => (
              <li key={v.decisionId} className={`${styles.row} ${i === 0 ? styles.rowLatest : ""}`} data-tier={v.tier}>
                <span className={styles.when}>
                  <time dateTime={v.screenedAt}><Stamp iso={v.screenedAt} /></time>
                  <span className="muted"><Stamp iso={v.screenedAt} rel /></span>
                </span>
                <span className={styles.tier}>
                  <TierBadge tier={v.tier} size="sm" />
                  <span className="mono">{v.score}</span>
                  {v.tierChanged && <span className="chip chip-warn">tier changed</span>}
                </span>
                <span className={styles.who}>
                  <span>{REQUESTER[v.requester]}</span>
                  <span className="muted small">{v.reasonCodes.filter((c) => c !== "CLEAN").slice(0, 3).join(" · ") || "clean"}</span>
                </span>
                <span className={styles.proof}>
                  <Link href={`/log/${encodeURIComponent(v.decisionId)}`} className="mono small">{v.decisionId}</Link>
                  <span className="muted small">
                    {v.attester ? <>attester <HexLink value={v.attester} explorerUrl={explorerUrl} /></> : "unsigned"}
                    {" · "}
                    {v.registryTx ? <>registry <HexLink value={v.registryTx} explorerUrl={explorerUrl} /></> : "registry pending"}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {h.tierChanges.length > 0 && (
        <section>
          <div className="sec-bar">
            <span className="sec-n">03</span>
            <span>Tier changes</span>
            <span className="sec-meta">{h.tierChanges.length} total</span>
          </div>
          <ul className={styles.changes}>
            {h.tierChanges.map((c, i) => (
              <li key={`${c.at}-${i}`}>
                <time dateTime={c.at} className="mono small"><Stamp iso={c.at} /></time>
                <span className={styles.arrow}>
                  <TierBadge tier={c.from ?? "UNKNOWN"} size="sm" /> <span className="muted">→</span> <TierBadge tier={c.to} size="sm" />
                </span>
                <span className="muted small">{c.via === "watch" ? `pushed to a watcher${c.trigger ? ` · ${c.trigger}` : ""}` : "seen in a verdict"}{c.decisionId ? <> · <Link href={`/log/${encodeURIComponent(c.decisionId)}`} className="mono">{c.decisionId}</Link></> : null}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.dev}>
        <button type="button" className={styles.devToggle} aria-expanded={dev} onClick={() => setDev((o) => !o)}>
          <span className="sec-n">04</span>
          <span>Developer view</span>
          <span className="sec-meta">{dev ? "hide" : "score dial · reasons · funder graph · attestation"}</span>
        </button>
        {dev && (
          <div className={styles.devBody}>
            {verdict ? (
              <VerdictView verdict={verdict} explorerUrl={explorerUrl} onSelectAddress={(a) => router.push(`/a/${a}`)} />
            ) : (
              <div className={styles.devEmpty}>
                <p className="muted">
                  The full verdict (evidence bundle, funder graph, analyst rationale) is produced by a fresh screen. It is free from this page and lands in the timeline above.
                </p>
                <button type="button" className="btn" onClick={() => void recheck()} disabled={busy}>
                  {busy ? "Checking…" : "Run a screen and show the full verdict"}
                </button>
                {h.latest && (
                  <p className="muted small">
                    Or replay the latest decision: <Link href={`/log/${encodeURIComponent(h.latest.decisionId)}`} className="mono">{h.latest.decisionId}</Link>
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <p className={`muted small ${styles.foot}`}>
        JSON: <a href={`/api/v1/address/${h.address}`} className="mono">/api/v1/address/{short(h.address, 6, 4)}</a> · <a href={`/api/v1/attestation/${h.address}`} className="mono">attestation</a> ·{" "}
        <a href={`/api/v1/badge/${h.address}.svg`} className="mono">badge</a> · generated <Stamp iso={h.generatedAt} />
      </p>
    </div>
  );
}
