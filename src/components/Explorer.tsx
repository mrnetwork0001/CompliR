"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Address, Verdict } from "@/lib/types";
import type { ExampleAddress, HealthResponse } from "@/app/api/_lib/public-types";
import { ADDR_RE, HttpError, getHealth, postJson } from "./api";
import { VerdictView } from "./VerdictView";
import styles from "./Explorer.module.css";

const FALLBACK_EXAMPLES: ExampleAddress[] = [
  { label: "demo HIGH", address: "0x000000000000000000000000000000000000dead", expectedTier: "HIGH" },
  { label: "demo MEDIUM", address: "0x000000000000000000000000000000000000beef", expectedTier: "MEDIUM" },
  { label: "demo LOW", address: "0x000000000000000000000000000000000000cafe", expectedTier: "LOW" },
];

type State = { status: "idle" } | { status: "loading"; address: string } | { status: "done"; verdict: Verdict } | { status: "error"; message: string; details?: unknown };

export function Explorer({ initialAddress = "", autoRun = false }: { initialAddress?: string; autoRun?: boolean } = {}) {
  const [address, setAddress] = useState(initialAddress);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    let alive = true;
    getHealth().then((h) => alive && setHealth(h));
    return () => {
      alive = false;
    };
  }, []);

  const examples = health?.examples?.length ? health.examples : FALLBACK_EXAMPLES;
  const explorerUrl = health?.network.explorerUrl ?? "";

  const run = useCallback(
    async (addr: string, opts?: { name?: string; amount?: string }) => {
      const a = addr.trim();
      if (!ADDR_RE.test(a)) {
        setState({ status: "error", message: "Enter a valid EVM address (0x + 40 hex characters)." });
        return;
      }
      const body: Record<string, unknown> = { address: a };
      const n = (opts?.name ?? name).trim();
      if (n.length >= 2) body.name = n;
      const amt = (opts?.amount ?? amount).trim();
      if (amt !== "" && Number.isFinite(Number(amt)) && Number(amt) >= 0) body.amountUsdc = Number(amt);
      body.clientId = "web-explorer";
      setState({ status: "loading", address: a });
      try {
        const v = await postJson<Verdict>("/api/v1/screen", body);
        setState({ status: "done", verdict: v });
      } catch (e) {
        if (e instanceof HttpError) {
          setState({ status: "error", message: e.status === 402 ? "This endpoint is x402-paid; the web explorer is only free when X402_DISABLED=1 on the server." : `${e.code}: ${e.message}`, details: e.details });
        } else {
          setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }
    },
    [amount, name],
  );

  // `?address=0x…` → prefill and run once on mount.
  useEffect(() => {
    if (!autoRun || !ADDR_RE.test(initialAddress)) return;
    const t = setTimeout(() => void run(initialAddress), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void run(address);
  }

  function pick(ex: ExampleAddress) {
    setAddress(ex.address);
    void run(ex.address);
  }

  const selectAddress = (a: Address) => {
    setAddress(a);
    void run(a);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className={`container ${styles.page}`}>
      <section className={styles.intro}>
        <p className="kicker">oracle · explorer · POST /api/v1/screen</p>
        <h1>Arc Trust Explorer</h1>
        <p className="muted">
          Paste any Arc address. CompliR collects evidence (sanctions, USDC blacklist, 2-hop funders, your payee book), scores it deterministically, and signs a
          verdict you can verify on-chain.
        </p>
      </section>

      <form className={`card ${styles.form}`} onSubmit={onSubmit}>
        <label className={styles.field}>
          <span>Address <span className={styles.req}>required</span></span>
          <input className="input mono" name="address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} inputMode="text" required pattern="0x[0-9a-fA-F]{40}" />
        </label>
        <div className={styles.row}>
          <label className={styles.field}>
            <span>Name <span className="muted">optional</span></span>
            <input className="input" name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Legal or display name for sanctions matching" maxLength={200} />
          </label>
          <label className={styles.field}>
            <span>Amount (USDC) <span className="muted">optional</span></span>
            <input className="input" name="amount" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="120" inputMode="decimal" min={0} type="number" step="any" />
          </label>
        </div>
        <div className={styles.actions}>
          <button type="submit" className="btn btnPrimary" disabled={state.status === "loading"}>
            {state.status === "loading" ? "Screening…" : "Screen address"}
          </button>
          <div className={styles.examples}>
            <span className="muted small">Try:</span>
            {examples.map((ex) => (
              <button key={ex.address} type="button" className={`btn btnSmall ${styles.ex} ${ex.expectedTier ? styles[`ex${ex.expectedTier}`] : ""}`} onClick={() => pick(ex)} disabled={state.status === "loading"} title={ex.address}>
                {ex.label}
              </button>
            ))}
          </div>
        </div>
        {health && (
          <p className={`muted small ${styles.meta}`}>
            {health.ok ? "Service online" : health.paused ? "Service paused" : "Service degraded"}
            {health.chainId ? ` · chain ${health.chainId}` : ""}
            {health.x402.disabled ? " · x402 off (free during demo)" : ` · ${health.x402.priceScreenUsdc} USDC per screen via x402`}
          </p>
        )}
      </form>

      {state.status === "loading" && (
        <div className={`card ${styles.loading}`} aria-busy="true" aria-live="polite">
          <div className={styles.spinner} aria-hidden="true" />
          <div>
            <strong>Screening {state.address.slice(0, 10)}…</strong>
            <p className="muted small">Collecting evidence, walking funders, asking the Risk Analyst, signing the attestation. Usually a few seconds.</p>
          </div>
        </div>
      )}

      {state.status === "error" && (
        <div className="alert alertError" role="alert">
          <strong>Screening failed.</strong> {state.message}
          {state.details ? <pre className={styles.details}>{JSON.stringify(state.details, null, 2)}</pre> : null}
        </div>
      )}

      {state.status === "done" && <VerdictView verdict={state.verdict} explorerUrl={explorerUrl} onSelectAddress={selectAddress} />}

      {state.status === "idle" && (
        <section className={styles.how}>
          <div className="card">
            <h3>1. Evidence</h3>
            <p className="muted small">OpenSanctions, Circle USDC blacklist, Arc protocol blocklist, 2-hop funder graph, lookalike check against your payee book.</p>
          </div>
          <div className="card">
            <h3>2. Score</h3>
            <p className="muted small">Deterministic rules produce 0–100. LOW 0–20, MEDIUM 21–60, HIGH 61–100. The Risk Analyst agent writes the rationale, limits and EDD.</p>
          </div>
          <div className="card">
            <h3>3. Attest</h3>
            <p className="muted small">EIP-712 signature + AttestationRegistry on Arc. Every verdict links to a hash-chained decision log entry you can replay.</p>
          </div>
        </section>
      )}
    </div>
  );
}
