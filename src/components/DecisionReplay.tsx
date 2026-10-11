"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { DecisionLogEntry } from "@/lib/types";
import { HttpError, apiFetch, fmtTime, getHealth } from "./api";
import { HexLink } from "./HexLink";
import { CopyButton } from "./CopyButton";
import { VerifyBadge } from "./VerifyBadge";
import { TierBadge } from "./TierBadge";
import styles from "./DecisionReplay.module.css";

type S = { status: "loading" } | { status: "done"; entry: DecisionLogEntry } | { status: "notfound" } | { status: "error"; message: string };

function summary(p: unknown): { tier?: "LOW" | "MEDIUM" | "HIGH"; score?: number; rationale?: string } {
  if (!p || typeof p !== "object") return {};
  const o = p as Record<string, unknown>;
  const v = (o.verdict && typeof o.verdict === "object" ? (o.verdict as Record<string, unknown>) : o) as Record<string, unknown>;
  const tier = v.tier;
  return {
    tier: tier === "LOW" || tier === "MEDIUM" || tier === "HIGH" ? tier : undefined,
    score: typeof v.score === "number" ? v.score : undefined,
    rationale: typeof v.rationale === "string" ? v.rationale : undefined,
  };
}

export function DecisionReplay({ id }: { id: string }) {
  const [s, setS] = useState<S>({ status: "loading" });
  const [explorerUrl, setExplorerUrl] = useState("");

  useEffect(() => {
    let alive = true;
    getHealth().then((h) => alive && setExplorerUrl(h.network.explorerUrl));
    apiFetch<DecisionLogEntry>(`/api/v1/decision/${encodeURIComponent(id)}`)
      .then((entry) => alive && setS({ status: "done", entry }))
      .catch((e) => {
        if (!alive) return;
        if (e instanceof HttpError && e.status === 404) setS({ status: "notfound" });
        else setS({ status: "error", message: e instanceof HttpError ? `${e.code}: ${e.message}` : String(e) });
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (s.status === "loading") {
    return (
      <div className="container">
        <h1>Decision <span className="mono">{id}</span></h1>
        <div className="card" style={{ marginTop: 16 }} aria-busy="true">
          <span className="skeleton" style={{ width: "60%" }} />
          <span className="skeleton" style={{ width: "80%", marginTop: 8 }} />
          <span className="skeleton" style={{ width: "40%", marginTop: 8 }} />
        </div>
      </div>
    );
  }
  if (s.status === "notfound") {
    return (
      <div className="container">
        <h1>Decision not found</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          No ledger entry with id <code>{id}</code>. Mock verdicts (<code>dec_mock</code>) are not persisted. Browse the <Link href="/ledger">ledger</Link> or run a new screening in the <Link href="/">Explorer</Link>.
        </p>
      </div>
    );
  }
  if (s.status === "error") {
    return (
      <div className="container">
        <h1>Decision <span className="mono">{id}</span></h1>
        <div className="alert alertError" role="alert" style={{ marginTop: 16 }}>
          {s.message}
        </div>
      </div>
    );
  }

  const e = s.entry;
  const sm = summary(e.payload);
  const json = JSON.stringify(e.payload, null, 2);

  return (
    <div className="container">
      <div className="pageHead">
        <div>
          <p className="kicker">records · decision · replay</p>
          <h1 className={styles.title}>
            <code>{e.kind}</code> #{e.seq}
            {sm.tier && <TierBadge tier={sm.tier} />}
            {typeof sm.score === "number" && <span className="muted">score {sm.score}</span>}
          </h1>
        </div>
        <VerifyBadge />
      </div>

      <div className="grid2">
        <section className="card">
          <h3>Entry</h3>
          <dl className={styles.kv}>
            <div><dt>Id</dt><dd className="mono break">{e.id}</dd></div>
            <div><dt>Kind</dt><dd><code>{e.kind}</code></dd></div>
            <div><dt>Seq</dt><dd className="mono">{e.seq}</dd></div>
            <div><dt>Subject</dt><dd>{e.subject ? <HexLink value={e.subject} explorerUrl={explorerUrl} full /> : <span className="muted">—</span>}</dd></div>
            <div><dt>Client</dt><dd className="mono break">{e.clientId ?? <span className="muted">—</span>}</dd></div>
            <div><dt>Created</dt><dd>{fmtTime(e.createdAt)}</dd></div>
          </dl>
        </section>
        <section className="card">
          <h3>Chain</h3>
          <dl className={styles.kv}>
            <div><dt>Prev hash</dt><dd className={styles.hash}><code className="break">{e.prevHash}</code><CopyButton text={e.prevHash} /></dd></div>
            <div><dt>This hash</dt><dd className={styles.hash}><code className="break">{e.hash}</code><CopyButton text={e.hash} /></dd></div>
            <div>
              <dt>Anchor tx</dt>
              <dd>{e.anchorTx ? <HexLink value={e.anchorTx} explorerUrl={explorerUrl} /> : <span className="badge badgeNeutral">pending (anchored in batches)</span>}</dd>
            </div>
          </dl>
          <p className="muted small" style={{ marginTop: 10 }}>
            <code>hash = keccak256(prevHash ‖ canonical(payload) ‖ seq ‖ kind)</code>. Use the verify button to re-walk the whole chain server-side.
          </p>
        </section>
      </div>

      {sm.rationale && (
        <section className="card" style={{ marginTop: 16 }}>
          <h3>Rationale</h3>
          <p className={styles.rationale}>{sm.rationale}</p>
        </section>
      )}

      <section className="card" style={{ marginTop: 16 }}>
        <div className={styles.payloadHead}>
          <h3>Payload</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <CopyButton text={json} label="Copy JSON" />
            <a className="btn btnSmall" href={`/api/v1/decision/${encodeURIComponent(e.id)}`} target="_blank" rel="noopener noreferrer">
              Raw JSON
            </a>
          </div>
        </div>
        <pre className={styles.payload}>
          <code>{json}</code>
        </pre>
      </section>
    </div>
  );
}
