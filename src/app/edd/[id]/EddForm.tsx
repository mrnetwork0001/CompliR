"use client";
import { useState } from "react";
import { TierBadge } from "@/components/TierBadge";
import { postJson, HttpError } from "@/components/api";
import type { EddPublicView, AnswerResult } from "@/lib/edd";
import styles from "./page.module.css";

const MAX = 1000;

export function EddForm({ initial }: { initial: EddPublicView }) {
  const [answers, setAnswers] = useState<string[]>(() => initial.questions.map(() => ""));
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<AnswerResult | null>(null);

  const alreadyAnswered = initial.status !== "OPEN";
  if (alreadyAnswered || result) {
    const rescreen = result?.rescreen ?? initial.rescreen;
    const ledgerId = result?.ledgerEntryId ?? initial.ledgerEntryId;
    return (
      <section className={`card ${styles.done}`} aria-live="polite">
        <h2>{result ? "Thank you — your answers were received." : "This request has already been answered."}</h2>
        {rescreen ? (
          <>
            <div className={styles.tierRow}>
              <span>Updated risk tier:</span>
              <TierBadge tier={rescreen.tier} size="lg" />
              {rescreen.previousTier && rescreen.changed ? (
                <span className="muted small">
                  changed from <TierBadge tier={rescreen.previousTier} size="sm" />
                </span>
              ) : rescreen.previousTier ? (
                <span className="muted small">unchanged</span>
              ) : null}
            </div>
            <p className="muted small">
              {rescreen.changed
                ? "The payer has been told the tier changed. They decide whether and when to pay."
                : "The deterministic rules did not change the tier. The payer's compliance reviewer still sees your answers."}
            </p>
          </>
        ) : (
          <p className="muted small">
            {result?.rescreenError
              ? "Your answers are on file. The automatic re-screen could not run right now; the reviewer will re-run it."
              : "Your answers are on file for the reviewer."}
          </p>
        )}
        <dl className={styles.dl}>
          {ledgerId ? (
            <>
              <dt>Decision log</dt>
              <dd>
                <a href={`/log/${ledgerId}`}>{ledgerId}</a> <span className="muted">(hash of your answers, not the text)</span>
              </dd>
            </>
          ) : null}
          {rescreen ? (
            <>
              <dt>New decision</dt>
              <dd>
                <a href={`/log/${rescreen.decisionId}`}>{rescreen.decisionId}</a>
              </dd>
            </>
          ) : null}
          {result?.answersHash ? (
            <>
              <dt>Answers hash</dt>
              <dd>
                <code className="break">{result.answersHash}</code>
              </dd>
            </>
          ) : null}
        </dl>
      </section>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (answers.some((a) => a.trim().length === 0)) { setErr("Please answer every question."); return; }
    setBusy(true);
    try {
      const r = await postJson<AnswerResult>(`/api/v1/edd/${initial.id}/answer`, { answers: answers.map((a) => a.trim()), ...(contact.trim() ? { contact: contact.trim() } : {}) });
      setResult(r);
    } catch (ex) {
      setErr(ex instanceof HttpError ? ex.message : "Could not submit. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`card ${styles.form}`} onSubmit={submit} noValidate>
      {initial.questions.map((q, i) => (
        <div className={styles.q} key={i}>
          <label className={styles.qLabel} htmlFor={`a${i}`}>
            <span className={styles.qNum}>{i + 1}.</span>
            {q}
          </label>
          <textarea
            id={`a${i}`}
            className={styles.textarea}
            maxLength={MAX}
            required
            value={answers[i]}
            onChange={(e) => setAnswers((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
            disabled={busy}
          />
          <span className={`small muted ${styles.counter}`}>{answers[i].length}/{MAX}</span>
        </div>
      ))}
      <div className={styles.q}>
        <label className={styles.qLabel} htmlFor="contact">
          Contact email <span className="muted small">(optional — only if the reviewer should follow up)</span>
        </label>
        <input id="contact" className="input" type="email" value={contact} onChange={(e) => setContact(e.target.value)} disabled={busy} autoComplete="email" />
      </div>
      {err ? <div className="alert alertError" role="alert">{err}</div> : null}
      <div className={styles.actions}>
        <button type="submit" className="btn btnPrimary" disabled={busy}>
          {busy ? "Submitting…" : "Send answers"}
        </button>
        <span className="small muted">You can answer once. Answers are stored privately; only their hash is public.</span>
      </div>
    </form>
  );
}
