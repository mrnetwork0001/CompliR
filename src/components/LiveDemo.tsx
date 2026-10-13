"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Verdict } from "@/lib/types";
import { HttpError, getHealth, postJson } from "./api";
import { VerdictView } from "./VerdictView";
import styles from "./LiveDemo.module.css";

const FALLBACK_HIGH = "0x098b716b8aaf21512996dc57eb0615e2383e2f96"; // Ronin Bridge exploiter (Lazarus Group), on OFAC SDN - a real sanctions hit

type S = { status: "loading"; address: string | null } | { status: "done"; verdict: Verdict; explorerUrl: string } | { status: "error"; message: string };

/**
 * Auto-runs the MEDIUM demo through the real pipeline on mount (POST /api/v1/screen) and renders the
 * full VerdictView: dial, reasons, rationale, 2-hop funder graph, EIP-712 attestation.
 */
export function LiveDemo() {
  const [s, setS] = useState<S>({ status: "loading", address: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      const health = await getHealth();
      const ex = health.examples?.find((e) => e.expectedTier === "HIGH") ?? health.examples?.[0];
      const address = ex?.address ?? FALLBACK_HIGH;
      if (!alive) return;
      setS({ status: "loading", address });
      try {
        const verdict = await postJson<Verdict>("/api/v1/screen", { address, clientId: "web-landing" });
        if (alive) setS({ status: "done", verdict, explorerUrl: health.network.explorerUrl ?? "" });
      } catch (e) {
        if (!alive) return;
        const message =
          e instanceof HttpError
            ? e.status === 402
              ? "This endpoint is x402-paid; the hosted demo is only free when X402_DISABLED=1 on the server."
              : `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        setS({ status: "error", message });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className={styles.wrap}>
      {s.status === "loading" && <Skeleton address={s.address} />}
      {s.status === "error" && (
        <div className="alert alertError" role="alert">
          <strong>Live demo unavailable.</strong> {s.message}{" "}
          <Link href="/explorer">Open the Explorer →</Link>
        </div>
      )}
      {s.status === "done" && (
        <>
          <VerdictView verdict={s.verdict} explorerUrl={s.explorerUrl} />
          <p className={`${styles.hint} muted small`}>
            This is a live verdict from the real pipeline, signed by the CompliR attester seconds ago.{" "}
            <Link href={`/explorer?address=${s.verdict.address}`}>Try another address →</Link>
          </p>
        </>
      )}
    </div>
  );
}

function Skeleton({ address }: { address: string | null }) {
  return (
    <div className={styles.skel} aria-busy="true" aria-live="polite">
      <div className={`card ${styles.skelHero}`}>
        <span className={`skeleton ${styles.skelDial}`} />
        <div className={styles.skelLines}>
          <span className="skeleton" style={{ width: 120, height: "1.6em" }} />
          <span className="skeleton" style={{ width: "80%" }} />
          <span className="skeleton" style={{ width: "60%" }} />
          <span className="skeleton" style={{ width: "45%" }} />
        </div>
      </div>
      <div className="grid2">
        <div className={`card ${styles.skelLines}`}>
          <span className="skeleton" style={{ width: 90, height: "1.2em" }} />
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" style={{ width: "70%" }} />
        </div>
        <div className={`card ${styles.skelLines}`}>
          <span className="skeleton" style={{ width: 130, height: "1.2em" }} />
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" style={{ width: "55%" }} />
        </div>
      </div>
      <p className="muted small">
        Screening {address ? <code>{address.slice(0, 10)}…</code> : "the demo address"} through the real pipeline: collecting evidence, walking funders two hops, asking the Risk Analyst, signing the attestation. Usually a few seconds.
      </p>
    </div>
  );
}
