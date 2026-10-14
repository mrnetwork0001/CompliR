import type { ReactNode } from "react";
import { CopyButton } from "@/components/CopyButton";
import styles from "../docs.module.css";

/** Code listing in mono with a copy button. `lang` is shown as a mono tag in the corner. */
export function Code({ code, lang }: { code: string; lang?: string }) {
  return (
    <figure className={`fig ${styles.code}`}>
      <div className="fig-head">
        <span className="fig-label">
          <span className={styles.codeDot} aria-hidden="true" />
          {lang ? <b>{lang}</b> : <b>listing</b>}
        </span>
        <span className={styles.codeTools}>
          <CopyButton text={code} />
        </span>
      </div>
      <pre className="fig-body">
        <code>{code}</code>
      </pre>
    </figure>
  );
}

/** Datasheet table on hairlines. `wide` columns wrap instead of nowrap. */
export function Table({ head, rows, wide = [] }: { head: ReactNode[]; rows: ReactNode[][]; wide?: number[] }) {
  return (
    <div className="tableWrap">
      <table className="table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={wide.includes(j) ? styles.wide : undefined}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Key / value spec list (label column + value column). */
export function Kv({ rows, mono = false }: { rows: { k: ReactNode; v: ReactNode }[]; mono?: boolean }) {
  return (
    <dl className={`dl ${mono ? "dl-mono" : ""} ${styles.kv}`}>
      {rows.map((r, i) => (
        <div key={i}>
          <dt>{r.k}</dt>
          <dd>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Status chip: live (accent), dry-run / pending (warn), off (muted). */
export function Status({ kind, children }: { kind: "live" | "dry-run" | "pending" | "off"; children?: ReactNode }) {
  const cls = kind === "live" ? "chip chip-acc" : kind === "off" ? "chip" : "chip chip-warn";
  return <span className={`${cls} ${styles.status}`}>{children ?? kind}</span>;
}

/** Inline address / id chip with an optional trailing note. */
export function Addr({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <>
      <code className={styles.addr}>{children}</code>
      {note && <span className={styles.note}> {note}</span>}
    </>
  );
}

/** A short aside on a 2 px accent rule (never a box). */
export function Note({ children }: { children: ReactNode }) {
  return <p className={styles.aside}>{children}</p>;
}
