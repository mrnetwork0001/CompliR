import { ADDR_RE, TX_RE, addressUrl, short, txUrl } from "./api";

/** Renders a tx hash or address as a link into the Arc explorer (falls back to plain mono text). */
export function HexLink({ value, explorerUrl, full = false }: { value: string; explorerUrl: string; full?: boolean }) {
  const isTx = TX_RE.test(value);
  const isAddr = ADDR_RE.test(value);
  const href = isTx ? txUrl(explorerUrl, value) : isAddr ? addressUrl(explorerUrl, value) : null;
  const text = full ? value : short(value, isTx ? 10 : 6, isTx ? 6 : 4);
  if (!href) return <code className="break" title={value}>{text}</code>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="mono break" title={value}>
      {text}
      <span className="srOnly"> (opens Arc explorer)</span>
    </a>
  );
}
