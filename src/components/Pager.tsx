"use client";
import styles from "./Pager.module.css";

/** Datasheet pager: mono "page N of M · K per page · total", prev/next. */
export function Pager({ page, pages, total, limit, onPage, label = "entries" }: { page: number; pages: number; total: number; limit: number; onPage: (p: number) => void; label?: string }) {
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  return (
    <nav className={styles.pager} aria-label="Pagination">
      <span className={styles.meta}>
        {from}–{to} of {total} {label} · {limit} per page · page {page} / {pages}
      </span>
      <span className={styles.buttons}>
        <button type="button" className="btn btnSmall" onClick={() => onPage(1)} disabled={page <= 1} aria-label="First page">«</button>
        <button type="button" className="btn btnSmall" onClick={() => onPage(page - 1)} disabled={page <= 1}>Prev</button>
        <button type="button" className="btn btnSmall" onClick={() => onPage(page + 1)} disabled={page >= pages}>Next</button>
        <button type="button" className="btn btnSmall" onClick={() => onPage(pages)} disabled={page >= pages} aria-label="Last page">»</button>
      </span>
    </nav>
  );
}
