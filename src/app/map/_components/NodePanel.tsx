"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Address, Verdict } from "@/lib/types";
import type { MapCandidate, MapNode, NodeHistory } from "@/lib/trustmap/types";
import { TierBadge } from "@/components/TierBadge";
import { HexLink } from "@/components/HexLink";
import { Glyph } from "@/components/Glyph";
import { HttpError, addressUrl, apiFetch, fmtRelative, fmtUsdc, short, TIER_ACTION } from "@/components/api";
import styles from "./TrustMap.module.css";

export type PanelItem = { kind: "node"; node: MapNode } | { kind: "candidate"; candidate: MapCandidate };

export function NodePanel({ item, pinned, explorerUrl, onClose, onPick, onPromoted }: { item: PanelItem; pinned: boolean; explorerUrl: string; onClose: () => void; onPick: (a: Address) => void; onPromoted: () => void }) {
  const address = item.kind === "node" ? item.node.address : item.candidate.address;
  const [hist, setHist] = useState<NodeHistory | null>(null);
  const [histFor, setHistFor] = useState<Address | null>(null);

  useEffect(() => {
    if (!pinned) return;
    let alive = true;
    apiFetch<NodeHistory>(`/api/v1/map/${address}`)
      .then((h) => { if (alive) { setHist(h); setHistFor(address); } })
      .catch(() => { if (alive) { setHist(null); setHistFor(address); } });
    return () => { alive = false; };
  }, [address, pinned]);

  const h = histFor === address ? hist : null;
  const arcAddr = addressUrl(explorerUrl, address);

  return (
    <div className={styles.panelInner}>
      <div className={styles.panelHead}>
        <div>
          <div className={styles.panelKicker}>
            {item.kind === "candidate" ? (pinned ? "Observed · not graded yet" : "Observed · hover · click to pin") : pinned ? "Selected counterparty" : "Hovering · click to pin"}
          </div>
          <code className={`break ${styles.panelAddr}`}>{address}</code>
        </div>
        {pinned && (
          <button type="button" className="btn btnSmall" onClick={onClose} aria-label="Close panel">
            Close
          </button>
        )}
      </div>

      {item.kind === "node" ? <GradedBody node={item.node} h={h} pinned={pinned} /> : <CandidateBody c={item.candidate} pinned={pinned} onPromoted={onPromoted} />}

      <div className={styles.links}>
        <Link href={`/explorer?address=${address}`} className={`btn btnSmall ${item.kind === "node" ? "btnPrimary" : ""}`}>
          Open in Explorer
        </Link>
        {arcAddr && (
          <a href={arcAddr} target="_blank" rel="noopener noreferrer" className="btn btnSmall">
            Arc explorer ↗
          </a>
        )}
        {pinned && h?.node?.decisionId && (
          <Link href={`/log/${h.node.decisionId}`} className="btn btnSmall">
            Decision log
          </Link>
        )}
      </div>

      {pinned && (
        <div>
          <div className={styles.sectionTitle}>{item.kind === "node" ? "Transfers on the map" : "Transfers with graded nodes"}</div>
          {!h && <span className="skeleton" style={{ width: "60%" }} />}
          {h && h.edges.length === 0 && <p className="muted small">No USDC transfers to or from other mapped addresses in the retained window.</p>}
          {h && h.edges.length > 0 && (
            <ul className={styles.edgeList}>
              {h.edges.slice(0, 12).map((e, i) => {
                const out = e.from === address;
                const other = out ? e.to : e.from;
                return (
                  <li key={`${e.txHash}-${i}`}>
                    <span className={out ? styles.out : styles.in}>{out ? "→" : "←"}</span>{" "}
                    <button type="button" className={styles.linkBtn} onClick={() => onPick(other)} title={other}>
                      {short(other)}
                    </button>{" "}
                    <span className="mono">{e.usdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC</span>{" "}
                    {e.source === "demo" ? <span className="muted small">demo</span> : <HexLink value={e.txHash} explorerUrl={explorerUrl} />}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {pinned && h && h.changes.length > 0 && (
        <div>
          <div className={styles.sectionTitle}>Tier history</div>
          <ul className={styles.edgeList}>
            {h.changes.map((c) => (
              <li key={c.id}>
                <TierBadge tier={c.from} size="sm" /> → <TierBadge tier={c.to} size="sm" /> <span className="muted small">score {c.score} · {fmtRelative(c.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {item.kind === "node" && pinned && (
        <dl className={styles.facts}>
          <dt>Last seen block</dt>
          <dd><BlockLink b={item.node.lastSeenBlock} explorerUrl={explorerUrl} /></dd>
        </dl>
      )}
    </div>
  );
}

function BlockLink({ b, explorerUrl }: { b: number; explorerUrl: string }) {
  const u = explorerUrl && b > 0 ? `${explorerUrl.replace(/\/$/, "")}/block/${b}` : null;
  return u ? <a href={u} target="_blank" rel="noopener noreferrer" className="mono">{b.toLocaleString()}</a> : <span className="mono">{b.toLocaleString()}</span>;
}

function GradedBody({ node, h, pinned }: { node: MapNode; h: NodeHistory | null; pinned: boolean }) {
  return (
    <>
      <div className={styles.scoreRow}>
        <TierBadge tier={node.tier} size="lg" />
        <span className={styles.scoreBig}>{node.score}</span>
        <span className="muted small">/ 100 · {TIER_ACTION[node.tier]}</span>
      </div>

      {node.changedAt != null && node.prevTier && (
        <div className={`alert alertInfo ${styles.changeNote}`}>
          Tier changed <TierBadge tier={node.prevTier} size="sm" /> → <TierBadge tier={node.tier} size="sm" /> {fmtRelative(node.changedAt)}
        </div>
      )}

      <dl className={styles.facts}>
        <dt>USDC received (24h)</dt>
        <dd>{fmtUsdc(node.usdcIn24h)}</dd>
        <dt>Graded</dt>
        <dd>{fmtRelative(node.lastGradedAt)}{node.firstGradedAt !== node.lastGradedAt ? <span className="muted"> · first {fmtRelative(node.firstGradedAt)}</span> : null}</dd>
        <dt>Source</dt>
        <dd>{node.source === "demo" ? "demo seed (not a real grade)" : "chain tailer · pipeline screen"}</dd>
      </dl>

      <div>
        <div className={styles.sectionTitle}>Reason codes</div>
        <div className={styles.codes}>
          {node.reasonCodes.length === 0 && <span className="muted small">none recorded</span>}
          {node.reasonCodes.map((c) => (
            <span key={c} className={`badge ${c === "CLEAN" ? "badgeLOW" : c.includes("SANCTION") || c.includes("BLACKLIST") || c.includes("BLOCKLIST") ? "badgeHIGH" : "badgeMEDIUM"}`}>
              {c}
            </span>
          ))}
        </div>
      </div>

      {pinned && h?.node?.rationale && (
        <div>
          <div className={styles.sectionTitle}>Analyst rationale</div>
          <p className={styles.rationale}>{h.node.rationale}</p>
        </div>
      )}
    </>
  );
}

function CandidateBody({ c, pinned, onPromoted }: { c: MapCandidate; pinned: boolean; onPromoted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Verdict | null>(null);

  async function screenNow() {
    setBusy(true);
    setErr(null);
    try {
      // same-origin: the hosted page screens for free; the tailer's clientId keeps the decision attributable to the map
      const v = await apiFetch<Verdict>("/api/v1/screen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: c.address, clientId: "trustmap" }) });
      await apiFetch(`/api/v1/map/${c.address}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decisionId: v.decisionId }) });
      setDone(v);
      onPromoted();
    } catch (e) {
      setErr(e instanceof HttpError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={styles.scoreRow}>
        <span className="badge badgeNeutral">OBSERVED</span>
        <span className="muted small">seen by the tailer, not graded yet</span>
      </div>
      <dl className={styles.facts}>
        <dt>USDC received (24h)</dt>
        <dd>{fmtUsdc(c.usdcIn24h)}</dd>
        <dt>USDC sent to graded (24h)</dt>
        <dd>{fmtUsdc(c.usdcOut24h)}</dd>
        <dt>Transfers</dt>
        <dd>{c.txCount.toLocaleString()}</dd>
        <dt>Seen in blocks</dt>
        <dd><span className="mono">{c.firstSeenBlock.toLocaleString()} – {c.lastSeenBlock.toLocaleString()}</span></dd>
        <dt>Code</dt>
        <dd>{c.isContract == null ? <span className="muted">not checked (no RPC spent)</span> : c.isContract ? "contract" : "EOA"}</dd>
        <dt>Source</dt>
        <dd>{c.source === "demo" ? "demo seed (synthetic)" : "chain tailer · USDC transfer logs"}</dd>
      </dl>
      {pinned && c.source !== "demo" && !done && (
        <div>
          <button type="button" className="btn btnPrimary btnSmall" disabled={busy} onClick={() => void screenNow()}>
            {busy ? "Screening…" : "Screen now →"}
          </button>
          <p className="muted small" style={{ marginTop: 6 }}>Runs the full pipeline on this address and puts it on its tier ring.</p>
        </div>
      )}
      {done && (
        <div className={`alert alertInfo ${styles.changeNote}`}>
          <Glyph name="check" tone="acc" size={12} /> Graded <TierBadge tier={done.tier} size="sm" /> score {done.score} - moving to its ring.
        </div>
      )}
      {err && <div className={`alert alertError ${styles.changeNote}`}>{err}</div>}
    </>
  );
}
