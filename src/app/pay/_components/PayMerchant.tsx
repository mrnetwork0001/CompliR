"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import type { PayLinkMerchant } from "@/lib/paylinks";
import { CopyButton } from "@/components/CopyButton";
import { TierBadge } from "@/components/TierBadge";
import { ADDR_RE, HttpError, apiFetch, fmtRelative, postJson, short } from "@/components/api";
import styles from "./pay.module.css";

const LS_KEY = "complir.paylinks";
type Saved = { id: string; key: string };
type CreateResponse = { id: string; url: string; merchantKey: string; merchantUrl: string; link: PayLinkMerchant };

function loadSaved(): Saved[] {
  try { const v = JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => x && typeof x.id === "string" && typeof x.key === "string") : []; } catch { return []; }
}
// localStorage as an external store: referentially stable snapshot per raw value, empty on the server.
const EMPTY: Saved[] = [];
let snapRaw: string | null = null; let snap: Saved[] = EMPTY;
const listeners = new Set<() => void>();
function getSnapshot(): Saved[] {
  let raw: string | null = null;
  try { raw = localStorage.getItem(LS_KEY); } catch { /* private mode */ }
  if (raw !== snapRaw) { snapRaw = raw; snap = raw ? loadSaved() : EMPTY; }
  return snap;
}
function subscribe(cb: () => void) { listeners.add(cb); window.addEventListener("storage", cb); return () => { listeners.delete(cb); window.removeEventListener("storage", cb); }; }
function writeSaved(next: Saved[]) { try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* private mode */ } listeners.forEach((l) => l()); }
async function fetchAll(list: Saved[]): Promise<Record<string, PayLinkMerchant | { error: string }>> {
  const entries = await Promise.all(list.map(async (s) => {
    try { return [s.id, await apiFetch<PayLinkMerchant>(`/api/v1/pay/${s.id}?key=${encodeURIComponent(s.key)}`)] as const; }
    catch (e) { return [s.id, { error: errMsg(e) }] as const; }
  }));
  return Object.fromEntries(entries);
}
function errMsg(e: unknown): string {
  return e instanceof HttpError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
}

export function PayMerchant() {
  const [merchant, setMerchant] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [hours, setHours] = useState("72");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateResponse | null>(null);
  const saved = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
  const [links, setLinks] = useState<Record<string, PayLinkMerchant | { error: string }>>({});

  useEffect(() => {
    if (!saved.length) return;
    let alive = true;
    fetchAll(saved).then((m) => { if (alive) setLinks(m); });
    return () => { alive = false; };
  }, [saved]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const body = { merchant: merchant.trim(), to: to.trim(), amountUsdc: Number(amount), memo: memo.trim() || undefined, expiresInHours: Number(hours) || 72 };
      const r = await postJson<CreateResponse>("/api/v1/pay", body);
      setCreated(r);
      writeSaved([{ id: r.id, key: r.merchantKey }, ...loadSaved().filter((s) => s.id !== r.id)].slice(0, 100));
    } catch (err) { setError(errMsg(err)); }
    finally { setBusy(false); }
  }

  const valid = merchant.trim().length > 0 && ADDR_RE.test(to.trim()) && Number(amount) > 0;

  return (
    <div className={`container ${styles.wrap}`}>
      <div className="pageHead">
        <div>
          <p className="small muted">oracle · payment links · inbound screening</p>
          <h1>Payment links</h1>
          <p className="muted">
            Screen the payer before you accept. A link screens the wallet your customer will send from; only a LOW-risk wallet
            is shown your address, MEDIUM waits for your review, HIGH is declined before any funds move.
          </p>
        </div>
      </div>

      <div className="sec-bar"><span className="sec-n">01</span><span>Create a link</span><span className="sec-meta">POST /api/v1/pay</span></div>
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.field}>
          <label htmlFor="pm-merchant">Merchant</label>
          <input id="pm-merchant" className="input" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="Acme Hosting" maxLength={80} required />
        </div>
        <div className={styles.field}>
          <label htmlFor="pm-amount">Amount (USDC)</label>
          <input id="pm-amount" className="input" type="number" inputMode="decimal" min="0.000001" step="0.000001" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25.00" required />
        </div>
        <div className={`${styles.field} ${styles.full}`}>
          <label htmlFor="pm-to">Destination address (Arc)</label>
          <input id="pm-to" className="input mono" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" pattern="^0x[0-9a-fA-F]{40}$" spellCheck={false} required />
        </div>
        <div className={styles.field}>
          <label htmlFor="pm-memo">Memo (optional)</label>
          <input id="pm-memo" className="input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Invoice 1042" maxLength={240} />
        </div>
        <div className={styles.field}>
          <label htmlFor="pm-hours">Expires in (hours)</label>
          <input id="pm-hours" className="input" type="number" min="1" max="8760" value={hours} onChange={(e) => setHours(e.target.value)} />
        </div>
        <div className={`${styles.actions} ${styles.full}`}>
          <button type="submit" className="btn btnPrimary" disabled={!valid || busy}>{busy ? "Creating…" : "Create link"}</button>
          <span className="small muted">Free. The merchant key is stored in this browser only.</span>
        </div>
      </form>
      {error && <div className="alert alertError" role="alert">{error}</div>}

      {created && (
        <div className={styles.result}>
          <dl className="dl">
            <div><dt>Payer link</dt><dd className="mono"><span className={styles.linkRow}><Link href={`/pay/${created.id}`}>{created.url}</Link><CopyButton text={created.url} /></span></dd></div>
            <div><dt>Merchant view</dt><dd className="mono"><span className={styles.linkRow}><Link href={`/pay/${created.id}?key=${created.merchantKey}`}>{short(created.merchantUrl, 40, 8)}</Link><CopyButton text={created.merchantUrl} /></span></dd></div>
            <div><dt>Expires</dt><dd>{fmtRelative(created.link.expiresAt)}</dd></div>
          </dl>
          <p className="small muted" style={{ marginTop: 10 }}>Send the payer link to your customer. Keep the merchant view private: it carries the key that accepts or declines.</p>
        </div>
      )}

      <section className={styles.section}>
        <div className="sec-bar"><span className="sec-n">02</span><span>Links created here</span><span className="sec-meta">{saved.length} stored</span></div>
        {saved.length === 0 ? (
          <p className="muted" style={{ marginTop: 14 }}>No links yet. Links you create in this browser appear here with their payer tier and status.</p>
        ) : (
          <div className="tableWrap">
            <table className="table">
              <thead><tr><th>Link</th><th>Amount</th><th>Status</th><th>Payer</th><th>Tier</th><th>Created</th></tr></thead>
              <tbody>
                {saved.map((s) => {
                  const l = links[s.id];
                  if (!l) return <tr key={s.id}><td className="mono">{s.id}</td><td colSpan={5} className="muted">loading…</td></tr>;
                  if ("error" in l) return <tr key={s.id}><td className="mono">{s.id}</td><td colSpan={5} className="muted">{l.error}</td></tr>;
                  return (
                    <tr key={s.id}>
                      <td className="mono"><Link href={`/pay/${s.id}?key=${s.key}`}>{s.id}</Link></td>
                      <td className="mono">{l.amountUsdc} USDC</td>
                      <td><span className={`${styles.status} ${styles[`s_${l.status}`]}`}>{l.status}</span></td>
                      <td className="mono">{l.payerAddress ? short(l.payerAddress) : "-"}</td>
                      <td>{l.payerTier ? <TierBadge tier={l.payerTier} size="sm" /> : <span className="muted">-</span>}</td>
                      <td className="muted">{fmtRelative(l.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
