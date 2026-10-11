"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Address } from "@/lib/types";
import type { MapNode, NodeHistory } from "@/lib/trustmap/types";
import { TierBadge } from "@/components/TierBadge";
import { HexLink } from "@/components/HexLink";
import { addressUrl, apiFetch, fmtRelative, fmtUsdc, short, TIER_ACTION } from "@/components/api";
import styles from "./TrustMap.module.css";

export function NodePanel({ node, pinned, explorerUrl, onClose, onPick }: { node: MapNode; pinned: boolean; explorerUrl: string; onClose: () => void; onPick: (a: Address) => void }) {
  const [hist, setHist] = useState<NodeHistory | null>(null);
  const [histFor, setHistFor] = useState<Address | null>(null);

  useEffect(() => {
    if (!pinned) return;
    let alive = true;
    apiFetch<NodeHistory>(`/api/v1/map/${node.address}`)
      .then((h) => { if (alive) { setHist(h); setHistFor(node.address); } })
      .catch(() => { if (alive) { setHist(null); setHistFor(node.address); } });
    return () => { alive = false; };
  }, [node.address, pinned]);

  const h = histFor === node.address ? hist : null;
  const blockUrl = explorerUrl ? `${explorerUrl.replace(/\/$/, "")}/block/${node.lastSeenBlock}` : null;
  const arcAddr = addressUrl(explorerUrl, node.address);

  return (
    <div className={styles.panelInner}>
      <div className={styles.panelHead}>
        <div>
          <div className={styles.panelKicker}>{pinned ? "Selected counterparty" : "Hovering · click to pin"}</div>
          <code className={`break ${styles.panelAddr}`}>{node.address}</code>
        </div>
        {pinned && (
          <button type="button" className="btn btnSmall" onClick={onClose} aria-label="Close panel">
            Close
          </button>
        )}
      </div>

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
        <dt>Last seen block</dt>
        <dd>{blockUrl ? <a href={blockUrl} target="_blank" rel="noopener noreferrer" className="mono">{node.lastSeenBlock.toLocaleString()}</a> : <span className="mono">{node.lastSeenBlock.toLocaleString()}</span>}</dd>
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

      {pinned && h?.node.rationale && (
        <div>
          <div className={styles.sectionTitle}>Analyst rationale</div>
          <p className={styles.rationale}>{h.node.rationale}</p>
        </div>
      )}

      <div className={styles.links}>
        <Link href={`/explorer?address=${node.address}`} className="btn btnPrimary btnSmall">
          Open in Explorer
        </Link>
        {arcAddr && (
          <a href={arcAddr} target="_blank" rel="noopener noreferrer" className="btn btnSmall">
            Arc explorer ↗
          </a>
        )}
        {pinned && h?.node.decisionId && (
          <Link href={`/log/${h.node.decisionId}`} className="btn btnSmall">
            Decision log
          </Link>
        )}
      </div>

      {pinned && (
        <div>
          <div className={styles.sectionTitle}>Transfers with other graded nodes</div>
          {!h && <span className="skeleton" style={{ width: "60%" }} />}
          {h && h.edges.length === 0 && <p className="muted small">No USDC transfers to or from other graded counterparties yet.</p>}
          {h && h.edges.length > 0 && (
            <ul className={styles.edgeList}>
              {h.edges.slice(0, 12).map((e, i) => {
                const out = e.from === node.address;
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
    </div>
  );
}
