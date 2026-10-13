/**
 * Address extraction for the consumer face: payment links and invoice text.
 * Pure functions, no I/O. Addresses come back lowercased.
 */
import type { Address } from "../types";

const ADDR_G = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HAS_ADDR = /0x[0-9a-fA-F]{40}/;

export interface LinkExtract {
  address: Address | null;
  /** "eip681" | "complir-pay" | "url" | "address" | "none" */
  kind: "eip681" | "complir-pay" | "url" | "address" | "none";
  /** amount in USDC when the link says so (EIP-681 `uint256=` / `value=` on a USDC transfer, or ?amount=) */
  amountUsdc: number | null;
  chainId: number | null;
  /** CompliR pay-link id when the link is https://…/pay/<id> and carries no address itself */
  payId: string | null;
}

function toAddr(s: string | null | undefined): Address | null {
  return s && ADDR.test(s) ? (s.toLowerCase() as Address) : null;
}

function amountFrom(params: URLSearchParams): number | null {
  // ERC-20 transfer form: ethereum:<token>@chain/transfer?address=<to>&uint256=<atomic>
  const atomic = params.get("uint256");
  if (atomic && /^\d+$/.test(atomic)) return Number(atomic) / 1e6;
  const value = params.get("value");
  if (value && /^\d+(\.\d+)?(e\d+)?$/i.test(value)) {
    const n = Number(value);
    // native `value` is wei-like; on Arc USDC is the gas token (18 dp in `value`). Treat ≥1e12 as atomic-18.
    return n >= 1e12 ? n / 1e18 : n;
  }
  for (const k of ["amount", "amountUsdc", "usdc"]) {
    const v = params.get(k);
    if (v && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** EIP-681: ethereum:<address>[@chainId][/function]?[params]  (also "ethereum:pay-<address>") */
export function parseEip681(input: string): LinkExtract | null {
  const m = input.trim().match(/^ethereum:(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d+))?(?:\/([a-zA-Z_]\w*))?(?:\?(.*))?$/);
  if (!m) return null;
  const [, target, chain, fn, query] = m;
  const params = new URLSearchParams(query ?? "");
  // transfer(address,uint256): the recipient is the `address` param, the target is the token contract
  const recipient = fn === "transfer" ? toAddr(params.get("address")) : toAddr(target);
  return { address: recipient, kind: "eip681", amountUsdc: amountFrom(params), chainId: chain ? Number(chain) : null, payId: null };
}

/** Any URL: CompliR /pay/<id> links, or any URL that carries an address in path, query or hash. */
export function parseUrlLink(input: string): LinkExtract | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const pay = u.pathname.match(/\/pay\/([^/?#]+)/);
  const params = u.searchParams;
  const inPath = toAddr(u.pathname.match(ADDR_G)?.[0]);
  const inQuery = [...params.values()].map((v) => toAddr(v.match(ADDR_G)?.[0])).find(Boolean) ?? null;
  const inHash = toAddr(u.hash.match(ADDR_G)?.[0]);
  const address = inQuery ?? inPath ?? inHash;
  if (pay) {
    const id = decodeURIComponent(pay[1]);
    return { address: address ?? toAddr(id), kind: "complir-pay", amountUsdc: amountFrom(params), chainId: null, payId: ADDR.test(id) ? null : id };
  }
  if (!address) return null;
  return { address, kind: "url", amountUsdc: amountFrom(params), chainId: null, payId: null };
}

/** The one entry point for the "Payment link" tab. Accepts a bare address too. */
export function extractFromLink(input: string): LinkExtract {
  const s = input.trim();
  const bare = toAddr(s);
  if (bare) return { address: bare, kind: "address", amountUsdc: null, chainId: null, payId: null };
  return parseEip681(s) ?? parseUrlLink(s) ?? (() => {
    const any = toAddr(s.match(ADDR_G)?.[0]);
    return any ? { address: any, kind: "url" as const, amountUsdc: null, chainId: null, payId: null } : { address: null, kind: "none" as const, amountUsdc: null, chainId: null, payId: null };
  })();
}

export interface InvoiceExtract {
  /** distinct addresses in order of first appearance */
  addresses: Address[];
  vendorName: string | null;
  /** total/amount due in USDC when a line says so */
  amountUsdc: number | null;
}

const LABELLED = /^(?:from|vendor|supplier|payee|bill(?:ed)?\s+from|issued\s+by|seller|company|beneficiary|pay(?:able)?\s+to)\s*[:\-–]\s*(.+)$/i;
const NOISE = /^(invoice|receipt|bill|statement|tax invoice|quote|estimate|page \d+|date|due|total|subtotal|amount|description|qty|quantity|unit|price|item|no\.?|number|#)/i;
const AMOUNT_LINE = /(?:total|amount\s+due|balance\s+due|total\s+due|grand\s+total)\D{0,20}?(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,6})?|\d+(?:\.\d{1,6})?)\s*(usdc|usd|\$)?/i;

/** Addresses + a best-effort vendor name + amount from free text (PDF text extraction output). */
export function extractFromInvoiceText(text: string): InvoiceExtract {
  const seen = new Set<string>();
  const addresses: Address[] = [];
  for (const m of text.match(ADDR_G) ?? []) {
    const a = m.toLowerCase() as Address;
    if (!seen.has(a)) {
      seen.add(a);
      addresses.push(a);
    }
  }
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  let vendorName: string | null = null;
  for (const l of lines) {
    const m = l.match(LABELLED);
    if (m && m[1].trim().length >= 2 && !ADDR.test(m[1].trim())) {
      vendorName = m[1].trim().slice(0, 120);
      break;
    }
  }
  if (!vendorName) {
    // first "name-like" line: letters, not noise, not an address, not a date, shortish
    const cand = lines.slice(0, 12).find((l) => /[A-Za-z]{3,}/.test(l) && !NOISE.test(l) && !HAS_ADDR.test(l) && !/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(l) && l.length <= 80 && !/@/.test(l));
    vendorName = cand ?? null;
  }
  let amountUsdc: number | null = null;
  for (const l of lines) {
    const m = l.match(AMOUNT_LINE);
    if (m) {
      const n = Number(m[1].replace(/[,\s]/g, ""));
      if (Number.isFinite(n)) {
        amountUsdc = n;
        if (/usdc/i.test(l)) break;
      }
    }
  }
  return { addresses, vendorName, amountUsdc };
}

/** Normalise a vendor name for the local "seen before" history key. */
export function vendorKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
