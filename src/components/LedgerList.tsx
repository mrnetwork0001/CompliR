"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { LedgerListResponse } from "@/app/api/_lib/public-types";
import type { DecisionLogEntry } from "@/lib/types";
import { HttpError, apiFetch, fmtRelative, fmtTime, short } from "./api";
import { VerifyBadge } from "./VerifyBadge";
import { TierBadge } from "./TierBadge";
import { Pager } from "./Pager";

function tierOf(e: DecisionLogEntry): "LOW" | "MEDIUM" | "HIGH" | null {
  const p = e.payload as { tier?: unknown; verdict?: { tier?: unknown } } | null;
  const t = p?.tier ?? p?.verdict?.tier;
  return t === "LOW" || t === "MEDIUM" || t === "HIGH" ? t : null;
}

export function LedgerList({ limit = 20 }: { limit?: number }) {
  const [data, setData] = useState<LedgerListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    let alive = true;
    apiFetch<LedgerListResponse>(`/api/v1/ledger?limit=${limit}&page=${page}`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e instanceof HttpError ? `${e.code}: ${e.message}` : String(e)));
    return () => {
      alive = false;
    };
  }, [limit, page]);

  return (
    <div className="container">
      <div className="pageHead">
        <div>
          <p className="kicker">records · ledger · hash-chained</p>
          <h1>Decision ledger</h1>
          <p className="muted">
            Every verdict is appended to a hash chain (<code>hash = keccak256(prevHash ‖ payload ‖ seq ‖ kind)</code>) and periodically Merkle-anchored on Arc.
          </p>
        </div>
        <VerifyBadge auto />
      </div>

      {error && (
        <div className="alert alertError" role="alert">
          Could not load ledger: {error}
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>Seq</th>
                <th>Kind</th>
                <th>Subject</th>
                <th>Tier</th>
                <th>Hash</th>
                <th>Anchor</th>
                <th>When</th>
                <th>Id</th>
              </tr>
            </thead>
            <tbody>
              {!data && !error && (
                <tr>
                  <td colSpan={8}>
                    <span className="skeleton" />
                  </td>
                </tr>
              )}
              {data && data.entries.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    Ledger is empty. Run a screening in the <Link href="/">Explorer</Link>.
                  </td>
                </tr>
              )}
              {data?.entries.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{e.seq}</td>
                  <td>
                    <code>{e.kind}</code>
                  </td>
                  <td className="mono">{e.subject ? short(e.subject) : "-"}</td>
                  <td>{tierOf(e) ? <TierBadge tier={tierOf(e)} size="sm" /> : <span className="muted">-</span>}</td>
                  <td className="mono" title={e.hash}>
                    {short(e.hash, 10, 6)}
                  </td>
                  <td>{e.anchorTx ? <span className="badge badgeLOW">anchored</span> : <span className="badge badgeNeutral">pending</span>}</td>
                  <td title={fmtTime(e.createdAt)}>{fmtRelative(e.createdAt)}</td>
                  <td>
                    <Link href={`/log/${encodeURIComponent(e.id)}`} className="mono small">
                      {e.id.length > 14 ? `${e.id.slice(0, 14)}…` : e.id}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {data && <Pager page={data.page} pages={data.pages} total={data.total} limit={data.limit} onPage={setPage} label="entries" />}
    </div>
  );
}
