/**
 * Payment links: "screen the payer before you accept".
 * A merchant creates a link (amount, memo, destination). The payer opens it, enters the wallet they will send from,
 * CompliR screens that wallet (clientId "pay") and the page shows payment instructions (LOW), a review notice (MEDIUM)
 * or a decline (HIGH). The merchant sees tier/score + the decision and can accept or decline via a private key.
 *
 * Table `pay_links` is created here (not in store/db.ts) so this module is self-contained.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db, migrate } from "../store";
import { config } from "../config";
import { screen } from "../pipeline";
import { AddressSchema, type Address, type Tier } from "../types";

export const PAY_STATUSES = ["OPEN", "SCREENED", "ACCEPTED", "DECLINED", "EXPIRED"] as const;
export type PayStatus = (typeof PAY_STATUSES)[number];
/** clientId recorded on every payer screen; counted as internal usage. */
export const PAY_CLIENT_ID = "pay";
/** Native USDC on Arc has 18 decimals (gas token); the ERC-20 interface has 6. EIP-681 `value=` is in native units. */
export const NATIVE_USDC_DECIMALS = 18;

export const CreatePayLinkSchema = z.object({
  merchant: z.string().trim().min(1).max(80),
  to: AddressSchema,
  amountUsdc: z.number().positive().max(1_000_000_000),
  memo: z.string().trim().max(240).optional(),
  expiresInHours: z.number().positive().max(24 * 365).default(72),
});
export type CreatePayLink = z.infer<typeof CreatePayLinkSchema>;
export const ScreenPayerSchema = z.object({ from: AddressSchema });
export const DecideSchema = z.object({ key: z.string().min(8).max(128), action: z.enum(["accept", "decline"]) });

export interface PayLink {
  id: string;
  merchant: string;
  to: Address;
  amountUsdc: number;
  memo: string | null;
  status: PayStatus;
  merchantKey: string;
  payerAddress: Address | null;
  payerTier: Tier | null;
  payerScore: number | null;
  payerDecisionId: string | null;
  payerEddUrl: string | null;
  createdAt: number;
  expiresAt: number;
  screenedAt: number | null;
  decidedAt: number | null;
}

/** What the payer (and anyone with the id) sees: never the merchant key or the payer's score detail. */
export interface PayLinkPublic {
  id: string;
  merchant: string;
  to: Address;
  amountUsdc: number;
  memo: string | null;
  status: PayStatus;
  payerAddress: Address | null;
  payerTier: Tier | null;
  payerDecisionId: string | null;
  payerEddUrl: string | null;
  createdAt: string;
  expiresAt: string;
  screenedAt: string | null;
  decidedAt: string | null;
  chainId: number;
  /** EIP-681 link, present only when the payer is LOW (or the merchant accepted). */
  paymentUri: string | null;
  url: string;
}
export interface PayLinkMerchant extends PayLinkPublic {
  payerScore: number | null;
  merchantUrl: string;
}

export class PayLinkError extends Error {
  constructor(readonly code: "NOT_FOUND" | "FORBIDDEN" | "BAD_STATE", message: string) { super(message); this.name = "PayLinkError"; }
}

const now = () => Math.floor(Date.now() / 1000);
const iso = (t: number | null) => (t == null ? null : new Date(t * 1000).toISOString());
const num = (v: unknown) => (v == null ? null : Number(v));
const str = (v: unknown) => (v == null ? null : String(v));

let ready: Promise<void> | null = null;
export function ensurePayLinksTable(): Promise<void> {
  if (!ready) ready = (async () => {
    await migrate();
    await db().execute(`CREATE TABLE IF NOT EXISTS pay_links (
      id TEXT PRIMARY KEY, merchant TEXT NOT NULL, to_address TEXT NOT NULL, amount_usdc REAL NOT NULL, memo TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN', merchant_key TEXT NOT NULL,
      payer_address TEXT, payer_tier TEXT, payer_score INTEGER, payer_decision_id TEXT, payer_edd_url TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, screened_at INTEGER, decided_at INTEGER)`);
  })();
  return ready;
}
/** test helper */
export function __resetPayLinks() { ready = null; }

export function newPayId(): string { return `pay_${randomBytes(6).toString("hex")}`; }
export function newMerchantKey(): string { return `mk_${randomBytes(16).toString("hex")}`; }

function rowToLink(x: Record<string, unknown>): PayLink {
  return {
    id: String(x.id), merchant: String(x.merchant), to: String(x.to_address) as Address, amountUsdc: Number(x.amount_usdc),
    memo: str(x.memo), status: String(x.status) as PayStatus, merchantKey: String(x.merchant_key),
    payerAddress: str(x.payer_address) as Address | null, payerTier: str(x.payer_tier) as Tier | null, payerScore: num(x.payer_score),
    payerDecisionId: str(x.payer_decision_id), payerEddUrl: str(x.payer_edd_url),
    createdAt: Number(x.created_at), expiresAt: Number(x.expires_at), screenedAt: num(x.screened_at), decidedAt: num(x.decided_at),
  };
}

export function baseUrl(): string { return config().PUBLIC_BASE_URL.replace(/\/$/, ""); }
export function payUrl(id: string): string { return `${baseUrl()}/pay/${id}`; }

/** USDC amount → integer native units (18 dp) as a decimal string, no float drift beyond 6 dp. */
export function toNativeUnits(amountUsdc: number, decimals = NATIVE_USDC_DECIMALS): string {
  const [whole, frac = ""] = amountUsdc.toFixed(6).split(".");
  const micro = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  return (micro * 10n ** BigInt(decimals - 6)).toString();
}
/** EIP-681 payment request for native USDC on Arc: ethereum:<to>@<chainId>?value=<units>. */
export function paymentUri(to: Address, amountUsdc: number, chainId = config().ARC_CHAIN_ID): string {
  return `ethereum:${to}@${chainId}?value=${toNativeUnits(amountUsdc)}`;
}

/** Status after applying expiry; persists EXPIRED lazily on read. */
export async function effectiveStatus(l: PayLink): Promise<PayStatus> {
  if ((l.status === "OPEN" || l.status === "SCREENED") && l.expiresAt <= now()) {
    await db().execute({ sql: `UPDATE pay_links SET status = 'EXPIRED' WHERE id = ? AND status IN ('OPEN','SCREENED')`, args: [l.id] });
    return "EXPIRED";
  }
  return l.status;
}

export async function createPayLink(input: CreatePayLink): Promise<PayLink> {
  await ensurePayLinksTable();
  const t = now();
  const l: PayLink = {
    id: newPayId(), merchant: input.merchant, to: input.to, amountUsdc: Number(input.amountUsdc.toFixed(6)), memo: input.memo?.trim() || null,
    status: "OPEN", merchantKey: newMerchantKey(), payerAddress: null, payerTier: null, payerScore: null, payerDecisionId: null, payerEddUrl: null,
    createdAt: t, expiresAt: t + Math.round(input.expiresInHours * 3600), screenedAt: null, decidedAt: null,
  };
  await db().execute({
    sql: `INSERT INTO pay_links (id, merchant, to_address, amount_usdc, memo, status, merchant_key, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [l.id, l.merchant, l.to, l.amountUsdc, l.memo, l.status, l.merchantKey, l.createdAt, l.expiresAt],
  });
  return l;
}

export async function getPayLink(id: string): Promise<PayLink | null> {
  await ensurePayLinksTable();
  if (!/^pay_[0-9a-f]{12}$/.test(id)) return null;
  const r = await db().execute({ sql: `SELECT * FROM pay_links WHERE id = ?`, args: [id] });
  if (!r.rows[0]) return null;
  const l = rowToLink(r.rows[0] as Record<string, unknown>);
  l.status = await effectiveStatus(l);
  return l;
}

export async function requirePayLink(id: string): Promise<PayLink> {
  const l = await getPayLink(id);
  if (!l) throw new PayLinkError("NOT_FOUND", `No payment link ${id}`);
  return l;
}

/** Screen the wallet the payer will send from. Re-screening while OPEN/SCREENED replaces the previous payer. */
export async function screenPayer(id: string, from: Address): Promise<PayLink> {
  const l = await requirePayLink(id);
  if (l.status !== "OPEN" && l.status !== "SCREENED") throw new PayLinkError("BAD_STATE", `Link is ${l.status}; the payer can no longer be changed.`);
  const v = await screen({ address: from, amountUsdc: l.amountUsdc, clientId: PAY_CLIENT_ID });
  const t = now();
  // HIGH is declined automatically: the merchant never has to look at it.
  const status: PayStatus = v.tier === "HIGH" ? "DECLINED" : "SCREENED";
  await db().execute({
    sql: `UPDATE pay_links SET status = ?, payer_address = ?, payer_tier = ?, payer_score = ?, payer_decision_id = ?, payer_edd_url = ?, screened_at = ?, decided_at = ? WHERE id = ?`,
    args: [status, v.address, v.tier, v.score, v.decisionId, v.edd?.url ?? null, t, status === "DECLINED" ? t : null, id],
  });
  return { ...l, status, payerAddress: v.address, payerTier: v.tier, payerScore: v.score, payerDecisionId: v.decisionId, payerEddUrl: v.edd?.url ?? null, screenedAt: t, decidedAt: status === "DECLINED" ? t : null };
}

export async function decidePayLink(id: string, key: string, action: "accept" | "decline"): Promise<PayLink> {
  const l = await requirePayLink(id);
  if (!safeEqual(l.merchantKey, key)) throw new PayLinkError("FORBIDDEN", "Merchant key does not match.");
  if (l.status !== "SCREENED") throw new PayLinkError("BAD_STATE", `Link is ${l.status}; only a SCREENED link can be decided.`);
  const status: PayStatus = action === "accept" ? "ACCEPTED" : "DECLINED";
  const t = now();
  await db().execute({ sql: `UPDATE pay_links SET status = ?, decided_at = ? WHERE id = ? AND status = 'SCREENED'`, args: [status, t, id] });
  return { ...l, status, decidedAt: t };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Payment instructions are shown to a LOW payer immediately, and to a MEDIUM payer once the merchant accepts. */
export function canPay(l: PayLink): boolean {
  return (l.status === "SCREENED" && l.payerTier === "LOW") || l.status === "ACCEPTED";
}

export function toPublic(l: PayLink): PayLinkPublic {
  return {
    id: l.id, merchant: l.merchant, to: l.to, amountUsdc: l.amountUsdc, memo: l.memo, status: l.status,
    payerAddress: l.payerAddress, payerTier: l.payerTier, payerDecisionId: l.payerDecisionId, payerEddUrl: l.payerEddUrl,
    createdAt: iso(l.createdAt)!, expiresAt: iso(l.expiresAt)!, screenedAt: iso(l.screenedAt), decidedAt: iso(l.decidedAt),
    chainId: config().ARC_CHAIN_ID, paymentUri: canPay(l) ? paymentUri(l.to, l.amountUsdc) : null, url: payUrl(l.id),
  };
}
export function toMerchant(l: PayLink): PayLinkMerchant {
  return { ...toPublic(l), payerScore: l.payerScore, merchantUrl: `${payUrl(l.id)}?key=${l.merchantKey}` };
}
