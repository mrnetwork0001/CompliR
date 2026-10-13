"use client";

import Link from "next/link";
import { useState } from "react";
import type { Address, Reason, Verdict } from "@/lib/types";
import { TierBadge } from "./TierBadge";
import { Glyph } from "./Glyph";
import { ScoreDial } from "./ScoreDial";
import { FunderGraph } from "./FunderGraph";
import { EvidenceTable } from "./Evidence";
import { HexLink } from "./HexLink";
import { CopyButton } from "./CopyButton";
import { useRegistryTx } from "./useRegistryTx";
import { TIER_ACTION, TIER_LABEL, fmtRelative, fmtTime, fmtUsdc, short } from "./api";
import styles from "./VerdictView.module.css";

const REASON_TEXT: Record<Reason["code"], string> = {
  SANCTIONS_DIRECT: "Address or resolved entity appears on a sanctions list (OpenSanctions)",
  USDC_BLACKLISTED: "Circle USDC contract reports this address as blacklisted",
  PROTOCOL_BLOCKLISTED: "Listed on the Arc protocol blocklist",
  FUNDER_1HOP_SANCTIONED: "A wallet that funded the subject is sanctioned",
  FUNDER_2HOP_SANCTIONED: "A wallet two hops upstream is sanctioned",
  FUNDER_1HOP_BLACKLISTED: "A wallet that funded the subject is USDC-blacklisted",
  FUNDER_2HOP_BLACKLISTED: "A wallet two hops upstream is USDC-blacklisted",
  FRESH_WALLET: "Fresh wallet: first seen < 7 days ago or fewer than 5 transactions",
  LOOKALIKE_OF_KNOWN_PAYEE: "Looks like one of your known payees (address-poisoning pattern)",
  PAYEE_ADDRESS_CHANGED: "Same payee name, different address than before",
  HIGH_CONCENTRATION: "Shares a funder with many other payees",
  PRIOR_HIGH_TIER: "Was rated HIGH by CompliR within the last 30 days",
  NO_HISTORY: "No on-chain footprint on Arc",
  NETWORK_HELD_ELSEWHERE: "Other CompliR integrators rated this address HIGH in the last 7 days (anonymised count)",
  NETWORK_SHARED_FUNDER: "Shares a funder with several of your own payees",
  COMMUNITY_TIP_VERIFIED: "A staked community tip about this address was verified",
  AGENT_REGISTERED: "Owns a registered ERC-8004 agent on Arc (positive signal)",
  AGENT_VALIDATED: "That agent has validations from independent validators (positive signal)",
  AGENT_DISPUTED: "That agent has negative feedback or a failed validation in the ERC-8004 registries",
  INBOUND_FLAGGED: "Received bridged USDC via CCTP from a sanctioned or blacklisted source-chain wallet (30 days)",
  CLEAN: "No risk signals found",
};

function ReasonRow({ reason, explorerUrl }: { reason: Reason; explorerUrl: string }) {
  const [open, setOpen] = useState(false);
  const positive = reason.code === "CLEAN";
  return (
    <li className={styles.reason}>
      <button type="button" className={styles.reasonHead} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`${styles.weight} ${positive ? styles.weightPositive : ""}`}>{positive ? <Glyph name="check" tone="low" size={12} title="no risk signals" /> : `+${reason.weight}`}</span>
        <span className={styles.reasonBody}>
          <code className={styles.code}>{reason.code}</code>
          <span className={styles.reasonText}>{REASON_TEXT[reason.code] ?? reason.code}</span>
        </span>
        <span className={styles.chev} aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className={styles.reasonEvidence}>
          <EvidenceTable data={reason.evidence} explorerUrl={explorerUrl} />
        </div>
      )}
    </li>
  );
}

export function VerdictView({ verdict, explorerUrl, onSelectAddress }: { verdict: Verdict; explorerUrl: string; onSelectAddress?: (a: Address) => void }) {
  const v = verdict;
  const att = v.attestation;
  const liveRegistryTx = useRegistryTx(verdict.address, verdict.attestation.registryTx);
  const attLive = { ...att, registryTx: liveRegistryTx };
  const limits = v.recommendedLimits;
  const pending = !attLive.registryTx;

  return (
    <div className={styles.wrap}>
      <section className={`card ${styles.hero}`}>
        <ScoreDial score={v.score} tier={v.tier} size={150} />
        <div className={styles.heroText}>
          <div className={styles.heroTop}>
            <TierBadge tier={v.tier} size="lg" />
            <span className={styles.action}>{TIER_ACTION[v.tier]}</span>
          </div>
          <h2 className={styles.tierLabel}>{TIER_LABEL[v.tier]}</h2>
          <p className={styles.addr}>
            <HexLink value={v.address} explorerUrl={explorerUrl} full />
          </p>
          <dl className={styles.limits}>
            <div>
              <dt>Max per tx</dt>
              <dd>{fmtUsdc(limits.maxPerTxUsdc)}</dd>
            </div>
            <div>
              <dt>Max per day</dt>
              <dd>{fmtUsdc(limits.maxPerDayUsdc)}</dd>
            </div>
            <div>
              <dt>Re-screen</dt>
              <dd title={fmtTime(v.nextRescreenAt)}>{fmtRelative(v.nextRescreenAt)}</dd>
            </div>
          </dl>
          <p className="muted small">
            Screened {fmtTime(v.screenedAt)} · decision <Link href={`/log/${encodeURIComponent(v.decisionId)}`} className="mono">{v.decisionId}</Link>
          </p>
        </div>
      </section>

      <div className="grid2">
        <section className="card">
          <h3 className={styles.h}>Reasons</h3>
          <p className="muted small">Deterministic rules. Expand a reason to see the evidence it is built on.</p>
          <ul className={styles.reasons}>
            {v.reasons.map((r, i) => (
              <ReasonRow key={`${r.code}-${i}`} reason={r} explorerUrl={explorerUrl} />
            ))}
          </ul>
        </section>

        <section className="card">
          <h3 className={styles.h}>Analyst rationale</h3>
          <p className={styles.rationale}>{v.rationale}</p>
          <h3 className={styles.h} style={{ marginTop: 14 }}>Enhanced due diligence</h3>
          {v.eddRequested.length === 0 ? (
            <p className="muted small">None requested.</p>
          ) : (
            <ol className={styles.edd}>
              {v.eddRequested.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ol>
          )}
          <p className="muted small" style={{ marginTop: 10 }}>
            Next re-screen: {fmtTime(v.nextRescreenAt)} ({fmtRelative(v.nextRescreenAt)})
          </p>
        </section>
      </div>

      <div className="grid2">
        <section className="card">
          <h3 className={styles.h}>Funder graph</h3>
          <p className="muted small">Who sent USDC to this address, and who funded them. Click a node to screen it.</p>
          <FunderGraph evidence={v.evidence} onSelect={onSelectAddress} />
        </section>

        <section className="card">
          <h3 className={styles.h}>Attestation (EIP-712)</h3>
          <dl className={styles.kv}>
            <div>
              <dt>Attester</dt>
              <dd><HexLink value={att.attester} explorerUrl={explorerUrl} /></dd>
            </div>
            <div>
              <dt>Subject</dt>
              <dd><HexLink value={att.typedData.message.subject} explorerUrl={explorerUrl} /></dd>
            </div>
            <div>
              <dt>Tier / score</dt>
              <dd className="mono">{att.typedData.message.tier} / {att.typedData.message.score}</dd>
            </div>
            <div>
              <dt>Decision hash</dt>
              <dd className="mono break">{short(att.typedData.message.decisionHash, 12, 8)}</dd>
            </div>
            <div>
              <dt>Issued</dt>
              <dd>{fmtTime(att.typedData.message.issuedAt)}</dd>
            </div>
            <div>
              <dt>Valid until</dt>
              <dd>{fmtTime(att.validUntil)} <span className="muted">({fmtRelative(att.validUntil)})</span></dd>
            </div>
            <div>
              <dt>Chain</dt>
              <dd className="mono">{att.typedData.domain.chainId} · {short(att.typedData.domain.verifyingContract)}</dd>
            </div>
            <div>
              <dt>Signature</dt>
              <dd className={styles.sig}>
                <code title={att.signature}>{short(att.signature, 14, 10)}</code>
                <CopyButton text={att.signature} label="Copy sig" />
              </dd>
            </div>
            <div>
              <dt>Registry tx</dt>
              <dd>
                {pending ? (
                  <span className="badge badgeNeutral">pending</span>
                ) : (
                  <HexLink value={attLive.registryTx!} explorerUrl={explorerUrl} />
                )}
              </dd>
            </div>
          </dl>
          <div className={styles.attActions}>
            <CopyButton text={JSON.stringify({ typedData: att.typedData, signature: att.signature }, null, 2)} label="Copy typed data + signature" />
            <Link href={`/log/${encodeURIComponent(v.decisionId)}`} className="btn btnSmall">Open decision log</Link>
          </div>
        </section>
      </div>
    </div>
  );
}
