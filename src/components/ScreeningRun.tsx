"use client";
/**
 * ScreeningRun - what is happening while a check runs. One lane per agent/source in the real pipeline
 * (src/lib/pipeline.ts): evidence collectors in parallel, hop-2 funder trace, the risk analyst, the signer.
 *
 * Honesty: /api/v1/check is a single request, so lanes move queued → running on the pipeline's TYPICAL timing
 * and never show "done" until the real verdict arrives; then every lane completes and the real total is shown.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./ScreeningRun.module.css";

type Lane = { id: string; name: string; what: string; startsAt: number };

const LANES: Lane[] = [
  { id: "sanctions", name: "Sanctions desk", what: "OpenSanctions: OFAC SDN, EU, UK, UN, Japan MOF", startsAt: 0 },
  { id: "blocklist", name: "Circle blocklist", what: "USDC isBlacklisted() on Arc, live contract call", startsAt: 0 },
  { id: "hop1", name: "Funder tracer · hop 1", what: "who sent this wallet USDC", startsAt: 0 },
  { id: "network", name: "Network signal", what: "other clients' verdicts, ERC-8004 reputation, CCTP inbound, tips", startsAt: 0.4 },
  { id: "hop2", name: "Funder tracer · hop 2", what: "who funded the funders", startsAt: 3.5 },
  { id: "analyst", name: "Risk analyst (Claude)", what: "limits, due-diligence questions, written rationale; cannot change the score", startsAt: 7 },
  { id: "signer", name: "Signer", what: "EIP-712 attestation, ledger entry, mirror to Arc", startsAt: Infinity },
];

const FACTS = [
  "Why two hops? Funds are rarely paid straight from a sanctioned wallet. They pass through one or two fresh wallets first.",
  "The score comes from fixed rules, not the AI. The analyst only proposes limits and questions, and code clamps them.",
  "Circle's own USDC blocklist is read live on Arc. A blacklisted wallet could not receive the transfer anyway.",
  "Every verdict is signed (EIP-712) and appended to a hash-chained ledger anyone can replay.",
  "A first check of a new wallet takes 20-60 s. After that, the verdict is served instantly and re-graded on a schedule.",
  "A smart contract can read the same verdict on-chain with one call: isAllowed(payee, MEDIUM).",
];

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(2, "0")}:${sec.toFixed(1).padStart(4, "0")}`;
};

/** What the finished panel shows: the plain-language verdict (from /api/v1/check). */
export interface ScreeningResult {
  tier: "LOW" | "MEDIUM" | "HIGH";
  score: number;
  headline: string;
  advice: string;
  reasons: string[];
}

const TIER_WORD: Record<ScreeningResult["tier"], string> = { LOW: "Safe to pay", MEDIUM: "Pay up to a limit", HIGH: "Don't pay" };

/**
 * Modal around ScreeningRun. Rendered into <body> (a backdrop-filtered ancestor would trap position:fixed on iOS).
 * While running it cannot be dismissed (the check keeps going either way); once done, Escape or the backdrop
 * closes it and "View full result" calls onView.
 */
export function ScreeningModal(props: { address: string; result: ScreeningResult | null; onView: () => void; onClose: () => void; viewLabel?: string }) {
  // only ever mounted after a user action, so document exists
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);
  useEffect(() => {
    if (!props.result) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className={styles.modalRoot}>
      <div className={styles.backdrop} onClick={props.result ? props.onClose : undefined} aria-hidden="true" />
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={props.result ? "Screening result" : "Screening in progress"}>
        <ScreeningRun {...props} />
      </div>
    </div>,
    document.body,
  );
}

export function ScreeningRun({ address, result = null, onView, onClose, viewLabel = "View full result" }: { address: string; result?: ScreeningResult | null; onView?: () => void; onClose?: () => void; viewLabel?: string }) {
  const done = result !== null;
  const viewRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!done) return;
    viewRef.current?.focus({ preventScroll: true });
    viewRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [done]);
  const t0 = useRef<number>(0);
  const [elapsed, setElapsed] = useState(0);
  const [doneAt, setDoneAt] = useState<number | null>(null);

  useEffect(() => {
    t0.current = performance.now();
    const id = setInterval(() => setElapsed((performance.now() - t0.current) / 1000), 100);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (done && doneAt === null) setDoneAt((performance.now() - t0.current) / 1000);
  }, [done, doneAt]);

  const now = doneAt ?? elapsed;
  const fact = FACTS[Math.floor(elapsed / 6) % FACTS.length];

  return (
    <section className={`fig ${styles.run}`} aria-live="polite" aria-busy={!done}>
      <div className="fig-head">
        <span className="fig-label">
          <span className={done ? styles.dotDone : styles.dot} aria-hidden="true" />
          <b>{done ? "Verdict signed" : "Screening in progress"}</b>
          <span className={styles.addr}>{address.slice(0, 8)}…{address.slice(-4)}</span>
        </span>
        <span className={`fig-meta ${styles.clock}`}>{fmt(now)}</span>
      </div>
      <div className={styles.rail} aria-hidden="true"><span className={done ? styles.railDone : styles.railRun} /></div>
      <ol className={styles.lanes}>
        {LANES.map((l) => {
          const state = done ? "done" : elapsed >= l.startsAt ? "running" : "queued";
          const t = state === "queued" ? null : Math.max(0, now - (Number.isFinite(l.startsAt) ? l.startsAt : now));
          return (
            <li key={l.id} className={`${styles.lane} ${styles[state]}`}>
              <span className={styles.mark} aria-hidden="true">
                {state === "done" ? (
                  <svg viewBox="0 0 12 12" width="12" height="12"><path d="M2 6.5 5 9l5-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                ) : state === "running" ? <span className={styles.spin} /> : <span className={styles.queued} />}
              </span>
              <span className={styles.body}>
                <span className={styles.name}>{l.name}</span>
                <span className={styles.what}>{l.what}</span>
                {state === "running" && <span className={styles.scan} aria-hidden="true" />}
              </span>
              <span className={styles.state}>{state === "queued" ? (l.id === "analyst" ? "waits for evidence" : l.id === "signer" ? "waits for verdict" : "queued") : state === "running" ? `${t!.toFixed(1)} s` : "done"}</span>
            </li>
          );
        })}
      </ol>
      {result ? (
        <div className={`${styles.result} ${styles["r" + result.tier]}`}>
          <div className={styles.resultHead}>
            <span className={`badge badge${result.tier}`}>{result.tier} · {result.score}</span>
            <span className={styles.resultWord}>{TIER_WORD[result.tier]}</span>
            <span className={styles.resultTime}>signed in {now.toFixed(1)} s</span>
          </div>
          {result.headline.replace(/[.!]+$/, "").toLowerCase() !== TIER_WORD[result.tier].toLowerCase() && <p className={styles.headline}>{result.headline}</p>}
          <p className={styles.advice}>{result.advice}</p>
          {result.reasons.length > 0 && (
            <p className={styles.codes}>{result.reasons.filter((c) => c !== "CLEAN").slice(0, 5).map((c) => <code key={c}>{c}</code>)}</p>
          )}
          <div className={styles.resultActions}>
            {onView && <button ref={viewRef} type="button" className="btn btnPrimary" onClick={onView}>{viewLabel}</button>}
            {onClose && <button type="button" className="btn" onClick={onClose}>Check another</button>}
          </div>
        </div>
      ) : (
        <>
          <p className={styles.fact}>{fact}</p>
          <p className={styles.note}>Stages follow the pipeline&apos;s typical timing; nothing is marked done until the real, signed verdict arrives.</p>
        </>
      )}
    </section>
  );
}
