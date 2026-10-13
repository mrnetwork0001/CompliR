import { ADDR_RE, TX_RE, fmtTime } from "./api";
import { HexLink } from "./HexLink";
import styles from "./Evidence.module.css";

const TIME_KEY = /(at|time|timestamp|seen|until|issued)$/i;

function Value({ k, v, explorerUrl }: { k: string; v: unknown; explorerUrl: string }) {
  if (v === null || v === undefined) return <span className="muted">-</span>;
  if (typeof v === "string") {
    if (TX_RE.test(v) || ADDR_RE.test(v)) return <HexLink value={v} explorerUrl={explorerUrl} />;
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return <span title={v}>{fmtTime(v)}</span>;
    return <span className="break">{v}</span>;
  }
  if (typeof v === "number") {
    if (TIME_KEY.test(k) && v > 1_000_000_000) return <span title={String(v)}>{fmtTime(v)}</span>;
    return <span className="mono">{v.toLocaleString()}</span>;
  }
  if (typeof v === "boolean") return <span className="mono">{v ? "true" : "false"}</span>;
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="muted">[]</span>;
    return (
      <ul className={styles.list}>
        {v.map((item, i) => (
          <li key={i}>
            <Value k={k} v={item} explorerUrl={explorerUrl} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof v === "object") return <EvidenceTable data={v as Record<string, unknown>} explorerUrl={explorerUrl} />;
  return <span>{String(v)}</span>;
}

/** Key/value rendering of a reason's `evidence` bag; hashes/addresses become explorer links. */
export function EvidenceTable({ data, explorerUrl }: { data: Record<string, unknown>; explorerUrl: string }) {
  const keys = Object.keys(data);
  if (keys.length === 0) return <span className="muted small">No evidence attached.</span>;
  return (
    <dl className={styles.dl}>
      {keys.map((k) => (
        <div key={k} className={styles.row}>
          <dt>{k}</dt>
          <dd>
            <Value k={k} v={data[k]} explorerUrl={explorerUrl} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
