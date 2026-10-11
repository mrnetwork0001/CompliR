"use client";

import { useCallback, useEffect, useState } from "react";
import type { LedgerVerifyResponse } from "@/app/api/_lib/public-types";
import { HttpError, apiFetch } from "./api";

type S = { status: "idle" } | { status: "loading" } | { status: "done"; r: LedgerVerifyResponse } | { status: "error"; message: string };

/** "Verify chain" button + result badge. Re-walks the hash chain server-side. */
export function VerifyBadge({ auto = false }: { auto?: boolean }) {
  const [s, setS] = useState<S>(auto ? { status: "loading" } : { status: "idle" });
  const fetchVerify = useCallback(
    () =>
      apiFetch<LedgerVerifyResponse>("/api/v1/ledger/verify")
        .then((r) => setS({ status: "done", r }))
        .catch((e: unknown) => setS({ status: "error", message: e instanceof HttpError ? `${e.code}: ${e.message}` : String(e) })),
    [],
  );
  const verify = () => {
    setS({ status: "loading" });
    void fetchVerify();
  };
  useEffect(() => {
    if (auto) void fetchVerify();
  }, [auto, fetchVerify]);

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }} aria-live="polite">
      {s.status === "done" && (
        <span className={`badge ${s.r.ok ? "badgeLOW" : "badgeHIGH"}`} title={`checked ${s.r.checkedAt}`}>
          {s.r.ok ? `chain intact · ${s.r.length} entries` : `BROKEN at seq ${s.r.brokenAt} · ${s.r.length} entries`}
        </span>
      )}
      {s.status === "error" && <span className="badge badgeHIGH">{s.message}</span>}
      <button type="button" className="btn btnSmall" onClick={verify} disabled={s.status === "loading"}>
        {s.status === "loading" ? "Verifying…" : s.status === "idle" ? "Verify chain" : "Re-verify"}
      </button>
    </span>
  );
}
