"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { Verdict } from "@/lib/types";
import { ADDR_RE, HttpError, getHealth, postJson } from "./api";
import { CopyButton } from "./CopyButton";
import styles from "./BadgeBuilder.module.css";

const DEMO = "0x000000000000000000000000000000000000beef";

export function BadgeBuilder() {
  const [input, setInput] = useState(DEMO);
  const [address, setAddress] = useState<string>("");
  const [origin] = useState(() => (typeof window !== "undefined" ? window.location.origin : ""));
  const [bust, setBust] = useState(0);
  const [screening, setScreening] = useState<"idle" | "running" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  const [examples, setExamples] = useState<{ label: string; address: string }[]>([]);

  useEffect(() => {
    let alive = true;
    getHealth().then((h) => alive && setExamples(h.examples ?? []));
    return () => {
      alive = false;
    };
  }, []);

  function show(a: string) {
    const v = a.trim().toLowerCase();
    if (!ADDR_RE.test(v)) {
      setErr("Enter a valid EVM address (0x + 40 hex characters).");
      return;
    }
    setErr("");
    setAddress(v);
    setScreening("idle");
  }
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    show(input);
  }

  async function screenNow() {
    if (!address) return;
    setScreening("running");
    try {
      await postJson<Verdict>("/api/v1/screen", { address, clientId: "web-badge" });
      setScreening("done");
      setBust(Date.now());
    } catch (e) {
      setScreening("error");
      setErr(e instanceof HttpError ? (e.status === 402 ? "Screening is x402-paid; free only when X402_DISABLED=1." : `${e.code}: ${e.message}`) : String(e));
    }
  }

  const badgePath = address ? `/api/v1/badge/${address}.svg` : "";
  const badgeUrl = `${origin}${badgePath}`;
  const attUrl = `${origin}/api/v1/attestation/${address}`;
  const imgSrc = bust ? `${badgePath}?t=${bust}` : badgePath;
  const md = `[![Screened by CompliR](${badgeUrl})](${attUrl})`;
  const html = `<a href="${attUrl}"><img src="${badgeUrl}" alt="Screened by CompliR" height="20"></a>`;

  return (
    <div className={`container ${styles.page}`}>
      <div className="pageHead">
        <div>
          <p className="kicker">oracle · badge · GET /api/v1/badge/:address.svg</p>
          <h1>Screened-by badge</h1>
          <p className="muted">
            Put a live CompliR verdict on a receipt, an invoice, a README or a payee profile. The badge reads the latest attestation from the store and is cached
            for 60 seconds; it links to the attestation JSON anyone can verify offline.
          </p>
        </div>
      </div>

      <form className={`card ${styles.form}`} onSubmit={onSubmit}>
        <label className={styles.field}>
          <span>Address</span>
          <input className="input mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} pattern="0x[0-9a-fA-F]{40}" required />
        </label>
        <div className={styles.actions}>
          <button type="submit" className="btn btnPrimary">Show badge</button>
          {examples.map((ex) => (
            <button key={ex.address} type="button" className="btn btnSmall mono" onClick={() => { setInput(ex.address); show(ex.address); }} title={ex.address}>
              {ex.label}
            </button>
          ))}
        </div>
        {err && <div className="alert alertError" role="alert">{err}</div>}
      </form>

      {address && (
        <>
          <section className={`card ${styles.preview}`}>
            <h3>Preview</h3>
            <div className={styles.previewRow}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img key={imgSrc} src={imgSrc} alt="Screened by CompliR badge preview" height={20} className={styles.img} />
              <span className="muted small">
                Grey &quot;unknown&quot; means this address has never been screened.{" "}
                <button type="button" className="btn btnSmall" onClick={screenNow} disabled={screening === "running"}>
                  {screening === "running" ? "Screening…" : screening === "done" ? "Screened · refresh" : "Screen it now"}
                </button>
              </span>
            </div>
            <p className="muted small">
              Badge: <a href={badgePath} target="_blank" rel="noopener noreferrer" className="mono break">{badgeUrl}</a>
              <br />
              Attestation JSON: <a href={`/api/v1/attestation/${address}`} target="_blank" rel="noopener noreferrer" className="mono break">{attUrl}</a>
              <br />
              Full verdict: <Link href={`/explorer?address=${address}`}>open in Explorer</Link>
            </p>
          </section>

          <div className="grid2">
            <section className={`card ${styles.snippet}`}>
              <div className={styles.snipHead}>
                <h3>Markdown</h3>
                <CopyButton text={md} label="Copy" />
              </div>
              <pre><code>{md}</code></pre>
            </section>
            <section className={`card ${styles.snippet}`}>
              <div className={styles.snipHead}>
                <h3>HTML</h3>
                <CopyButton text={html} label="Copy" />
              </div>
              <pre><code>{html}</code></pre>
            </section>
          </div>

          <p className="muted small">
            The badge shows the tier and the attestation&apos;s <code>validUntil</code>: LOW is valid 7 days, MEDIUM 24 hours, HIGH 1 hour. After that it reads &quot;expired&quot; until the
            address is screened again, for example by a <code>/api/v1/watch</code> subscription.
          </p>
        </>
      )}
    </div>
  );
}
