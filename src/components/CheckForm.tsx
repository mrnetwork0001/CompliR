"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { Address } from "@/lib/types";
import type { CheckResponse, CheckSource } from "@/lib/check/plain";
import { extractFromLink, vendorKey } from "@/lib/check/extract";
import { ADDR_RE, HttpError, apiFetch, postJson } from "./api";
import { Glyph } from "./Glyph";
import styles from "./CheckForm.module.css";

const EXAMPLES: { label: string; address: Address; expect: string }[] = [
  { label: "Ronin Bridge exploiter (sanctioned)", address: "0x098b716b8aaf21512996dc57eb0615e2383e2f96", expect: "don't pay" },
  { label: "CompliR treasury wallet", address: "0xc742ada2872a042dd36d2e706907b4036968960c", expect: "safe" },
];

const VENDOR_KEY = "complir.vendors";
type VendorBook = Record<string, { address: Address; name: string; seenAt: string }>;
function readVendors(): VendorBook {
  try {
    const raw = localStorage.getItem(VENDOR_KEY);
    return raw ? (JSON.parse(raw) as VendorBook) : {};
  } catch {
    return {};
  }
}
function writeVendor(name: string, address: Address) {
  try {
    const book = readVendors();
    book[vendorKey(name)] = { address, name, seenAt: new Date().toISOString() };
    localStorage.setItem(VENDOR_KEY, JSON.stringify(book));
  } catch {
    /* private mode */
  }
}

interface InvoiceResult {
  fileName: string;
  pages: number;
  addresses: Address[];
  vendorName: string | null;
  amountUsdc: number | null;
  snippet: string;
}

type Tab = CheckSource;
type Status = { kind: "idle" } | { kind: "busy"; what: string } | { kind: "error"; message: string };

export function CheckForm({ initialAddress = "" }: { initialAddress?: string }) {
  const router = useRouter();
  const baseId = useId();
  const [tab, setTab] = useState<Tab>("address");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // address tab
  const [address, setAddress] = useState(initialAddress);
  // link tab
  const [link, setLink] = useState("");
  const [resolved, setResolved] = useState<{ id: string; address: Address | null } | null>(null);
  // invoice tab
  const [invoice, setInvoice] = useState<InvoiceResult | null>(null);
  const [picked, setPicked] = useState<Address | "">("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const parsedLink = useMemo(() => extractFromLink(link), [link]);
  /** the resolution for the pay id currently in the box (stale ids are ignored, no reset needed) */
  const resolvedPay = resolved && resolved.id === parsedLink.payId ? resolved : null;

  // CompliR /pay/<id> links without an address: ask the pay endpoint (another module) for the payee; tolerate absence.
  useEffect(() => {
    if (!parsedLink.payId || parsedLink.address) return;
    const id = parsedLink.payId;
    let alive = true;
    apiFetch<Record<string, unknown>>(`/api/v1/pay/${encodeURIComponent(id)}`)
      .then((r) => {
        const cand = [r.address, r.to, r.payee, r.recipient, (r.invoice as Record<string, unknown> | undefined)?.address].find((v) => typeof v === "string" && ADDR_RE.test(v));
        if (alive) setResolved({ id, address: cand ? ((cand as string).toLowerCase() as Address) : null });
      })
      .catch(() => alive && setResolved({ id, address: null }));
    return () => {
      alive = false;
    };
  }, [parsedLink.payId, parsedLink.address]);

  // vendor seen before with a different address? (localStorage; empty on the server and before a vendor is typed)
  const vendorPrev = useMemo<{ address: Address; seenAt: string } | null>(() => {
    if (!vendor.trim() || !picked) return null;
    const prev = readVendors()[vendorKey(vendor)];
    return prev && prev.address !== picked ? { address: prev.address, seenAt: prev.seenAt } : null;
  }, [vendor, picked]);

  const target: { address: Address | null; name?: string; amountUsdc?: number } = useMemo(() => {
    if (tab === "address") return { address: ADDR_RE.test(address.trim()) ? (address.trim().toLowerCase() as Address) : null };
    if (tab === "link") return { address: parsedLink.address ?? resolvedPay?.address ?? null, amountUsdc: parsedLink.amountUsdc ?? undefined };
    const amt = Number(amount);
    return { address: picked || null, name: vendor.trim().length >= 2 ? vendor.trim() : undefined, amountUsdc: amount !== "" && Number.isFinite(amt) && amt >= 0 ? amt : undefined };
  }, [tab, address, parsedLink, resolvedPay, picked, vendor, amount]);

  const run = useCallback(
    async (addr: Address, extra: { name?: string; amountUsdc?: number } = {}, source: CheckSource = tab) => {
      setStatus({ kind: "busy", what: addr });
      try {
        const res = await postJson<CheckResponse>("/api/v1/check", { address: addr, source, ...(extra.name ? { name: extra.name } : {}), ...(extra.amountUsdc != null ? { amountUsdc: extra.amountUsdc } : {}) });
        if (source === "invoice" && extra.name) writeVendor(extra.name, addr);
        const path = (() => {
          try {
            return new URL(res.shareUrl).pathname;
          } catch {
            return `/a/${addr}`;
          }
        })();
        router.push(path);
      } catch (e) {
        setStatus({ kind: "error", message: e instanceof HttpError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e) });
      }
    },
    [router, tab],
  );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!target.address) {
      setStatus({ kind: "error", message: tab === "address" ? "Enter a valid address: 0x followed by 40 hex characters." : tab === "link" ? "No address found in that link." : "Pick the address to pay from the invoice." });
      return;
    }
    void run(target.address, { name: target.name, amountUsdc: target.amountUsdc });
  }

  async function onFile(file: File | null) {
    setInvoice(null);
    setPicked("");
    setVendor("");
    setAmount("");
    if (!file) return;
    setStatus({ kind: "busy", what: `reading ${file.name}` });
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await apiFetch<InvoiceResult>("/api/v1/check/invoice", { method: "POST", body: fd });
      setInvoice(r);
      setPicked(r.addresses[0] ?? "");
      setVendor(r.vendorName ?? "");
      setAmount(r.amountUsdc != null ? String(r.amountUsdc) : "");
      setStatus({ kind: "idle" });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof HttpError ? e.message : e instanceof Error ? e.message : String(e) });
    }
  }

  const busy = status.kind === "busy";
  const tabs: { id: Tab; label: string; hint: string }[] = [
    { id: "address", label: "Address", hint: "paste 0x…" },
    { id: "link", label: "Payment link", hint: "EIP-681 · /pay/… · any URL" },
    { id: "invoice", label: "Invoice (PDF)", hint: "upload, we read it" },
  ];

  return (
    <div className={`container ${styles.page}`}>
      <div className="pageHead">
        <div>
          <p className="kicker">oracle · check · POST /api/v1/check</p>
          <h1>Check before you pay</h1>
          <p className="muted">
            Paste the address, the payment link or the invoice. CompliR grades the wallet in one call and tells you in plain English whether to pay, how much,
            or not at all. Every answer is signed, mirrored on Arc and kept on a public page you can share.
          </p>
        </div>
        <p className={`muted small ${styles.free}`}>free · no account · ~5 s</p>
      </div>

      <form className={`fig ${styles.form}`} onSubmit={onSubmit} aria-busy={busy}>
        <div className="fig-head">
          <span className="fig-label">
            <span><b>Fig. 01</b> · what are you paying</span>
          </span>
          <span className="fig-meta">verdict → /a/&lt;address&gt;</span>
        </div>
        <div className="fig-body">
          <div className={styles.tabs} role="tablist" aria-label="Input type">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`${baseId}-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`${baseId}-panel-${t.id}`}
                className={`${styles.tab} ${tab === t.id ? styles.tabOn : ""}`}
                onClick={() => {
                  setTab(t.id);
                  setStatus({ kind: "idle" });
                }}
              >
                <span className={styles.tabLabel}>{t.label}</span>
                <span className={styles.tabHint}>{t.hint}</span>
              </button>
            ))}
          </div>

          <div role="tabpanel" id={`${baseId}-panel-${tab}`} aria-labelledby={`${baseId}-tab-${tab}`} className={styles.panel}>
            {tab === "address" && (
              <label className={styles.field}>
                <span>Address <b className={styles.req}>required</b></span>
                <input className="input mono" name="address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} inputMode="text" pattern="0x[0-9a-fA-F]{40}" autoFocus />
              </label>
            )}

            {tab === "link" && (
              <>
                <label className={styles.field}>
                  <span>Payment link <b className={styles.req}>required</b></span>
                  <input className="input mono" name="link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="ethereum:0x…@5042?value=…  ·  https://…/pay/<id>  ·  any URL with an address" autoComplete="off" spellCheck={false} autoFocus />
                </label>
                {link.trim() !== "" && (
                  <dl className={`dl ${styles.readout}`}>
                    <div>
                      <dt>link type</dt>
                      <dd className="mono">{{ eip681: "EIP-681", "complir-pay": "CompliR pay link", url: "URL", address: "bare address", none: "unrecognised" }[parsedLink.kind]}</dd>
                    </div>
                    <div>
                      <dt>address</dt>
                      <dd className="mono break">{target.address ?? (parsedLink.payId ? (resolvedPay ? "pay link does not expose a payee" : "resolving pay link…") : "none found")}</dd>
                    </div>
                    {parsedLink.chainId != null && (
                      <div>
                        <dt>chain</dt>
                        <dd className="mono">{parsedLink.chainId}{parsedLink.chainId === 5042 ? " · Arc" : ""}</dd>
                      </div>
                    )}
                    {parsedLink.amountUsdc != null && (
                      <div>
                        <dt>amount</dt>
                        <dd className="mono">{parsedLink.amountUsdc.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC</dd>
                      </div>
                    )}
                  </dl>
                )}
              </>
            )}

            {tab === "invoice" && (
              <>
                <label className={styles.field}>
                  <span>Invoice PDF <b className={styles.req}>required</b> <span className="muted">· ≤ 5 MB · read on the server, not stored</span></span>
                  <input ref={fileRef} className={`input ${styles.file}`} type="file" name="file" accept="application/pdf,.pdf" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} />
                </label>
                {invoice && (
                  <div className={styles.invoice}>
                    <p className="muted small mono">
                      {invoice.fileName} · {invoice.pages} page{invoice.pages === 1 ? "" : "s"} · {invoice.addresses.length} address{invoice.addresses.length === 1 ? "" : "es"} found
                    </p>
                    {invoice.addresses.length === 0 ? (
                      <div className="alert alertError" role="alert">
                        <strong>No wallet address in this PDF.</strong> If the invoice is a scan, the text is not readable; paste the address instead.
                      </div>
                    ) : (
                      <fieldset className={styles.radios}>
                        <legend className={styles.legend}>Pay to</legend>
                        {invoice.addresses.map((a) => (
                          <label key={a} className={`${styles.radio} ${picked === a ? styles.radioOn : ""}`}>
                            <input type="radio" name="picked" value={a} checked={picked === a} onChange={() => setPicked(a)} />
                            <code className="break">{a}</code>
                          </label>
                        ))}
                      </fieldset>
                    )}
                    <div className={styles.row}>
                      <label className={styles.field}>
                        <span>Vendor <span className="muted">from the invoice · editable</span></span>
                        <input className="input" name="vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Who is billing you" maxLength={200} />
                      </label>
                      <label className={styles.field}>
                        <span>Amount (USDC) <span className="muted">optional</span></span>
                        <input className="input" name="amount" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="250" inputMode="decimal" type="number" min={0} step="any" />
                      </label>
                    </div>
                    {vendorPrev && (
                      <div className={`alert alertError ${styles.changed}`} role="alert">
                        <Glyph name="alert" tone="high" size={12} title="address changed" />{" "}
                        <strong>Address changed.</strong> You last checked <em>{vendor.trim()}</em> at <code>{vendorPrev.address}</code> on {new Date(vendorPrev.seenAt).toLocaleDateString()}.
                        This invoice asks for a different wallet. Confirm with the vendor out of band before paying.
                      </div>
                    )}
                    <p className={`muted small ${styles.snippet}`}>{invoice.snippet}</p>
                  </div>
                )}
              </>
            )}
          </div>

          <div className={styles.actions}>
            <button type="submit" className="btn btnPrimary btnLg" disabled={busy || !target.address}>
              {busy ? "Checking…" : "Check"}
            </button>
            <span className={styles.examples}>
              <span className="muted small">Try:</span>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.address}
                  type="button"
                  className={`btn btnSmall ${styles.ex}`}
                  disabled={busy}
                  title={ex.address}
                  onClick={() => {
                    setTab("address");
                    setAddress(ex.address);
                    void run(ex.address, {}, "address");
                  }}
                >
                  {ex.label} <span className="muted">→ {ex.expect}</span>
                </button>
              ))}
            </span>
          </div>

          {status.kind === "busy" && (
            <p className={`muted small ${styles.busy}`} aria-live="polite">
              <span className="live-dot" aria-hidden="true" /> {status.what.startsWith("0x") ? `Grading ${status.what.slice(0, 10)}… sanctions, Circle blocklist, two hops of funders, signed verdict.` : status.what}
            </p>
          )}
          {status.kind === "error" && (
            <div className="alert alertError" role="alert">
              {status.message}
            </div>
          )}
        </div>
      </form>

      <dl className={`dl ${styles.what}`}>
        <div>
          <dt>Don&apos;t pay</dt>
          <dd>Sanctions list, Circle USDC blocklist, Arc protocol blocklist, or funded directly by one of those.</dd>
        </div>
        <div>
          <dt>Pay up to N</dt>
          <dd>Something upstream looks off: a sanctioned wallet two hops back, a fresh wallet, a name that changed address. We cap the amount.</dd>
        </div>
        <div>
          <dt>Safe to pay</dt>
          <dd>No sanctions, no blocklist, normal history. Signed EIP-712 verdict, mirrored on Arc, re-graded on a cadence.</dd>
        </div>
        <div>
          <dt>Privacy</dt>
          <dd>Addresses you check join the public history on their /a/ page. Invoices are read in memory and discarded; your vendor list stays in this browser.</dd>
        </div>
      </dl>
    </div>
  );
}
