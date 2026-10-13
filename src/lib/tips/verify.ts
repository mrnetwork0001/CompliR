/**
 * Tip verification — deterministic, replayable checks run by the agent (no LLM in the decision):
 *   (a) re-screen the subject through the normal pipeline (`screen({address, clientId:"tips"}, {kind:"RESCREEN"})`)
 *   (b) corroboration
 *       - evidence tx hashes: `eth_getTransactionReceipt` on Arc; a receipt that involves the subject (from / to /
 *         a log emitted by or about the subject) is STRONG, a receipt that exists but does not touch the subject is weak,
 *         a missing receipt counts for nothing
 *       - evidence URLs: hostname on STRONG_URL_DOMAINS (OFAC, OpenSanctions, EU, UK) is STRONG, any other URL is weak
 *   (c) decision
 *       VERIFIED      re-screen HIGH, or MEDIUM with ≥ 1 strong corroboration
 *       REJECTED      re-screen LOW with no corroboration at all
 *       NEEDS_REVIEW  everything else (LOW + something, MEDIUM alone, or the re-screen failed)
 *
 * The verification record shown to the submitter carries tier / score / reason codes / decision id only — never the
 * evidence bundle, never another client's data.
 */
import type { PublicClient } from "viem";
import { arcClient } from "../evidence/rpc";
import { screen as pipelineScreen } from "../pipeline";
import type { Address, ScreenRequest, Verdict } from "../types";
import { CATEGORY_MULTIPLIER, STRONG_URL_DOMAINS, TIPS_CLIENT_ID, round6, tipsEnv, type Tip, type TipCategory, type TipDecision, type TipVerification, type TxCorroboration, type UrlCorroboration } from "./model";

export type ScreenFn = (req: ScreenRequest, opts?: { kind?: "SCREEN" | "RESCREEN"; writeOnChain?: boolean }) => Promise<Verdict>;
export type ReceiptClient = Pick<PublicClient, "getTransactionReceipt">;

export interface VerifyOptions {
  /** injected for tests; default: the real pipeline */
  screenFn?: ScreenFn;
  /** injected for tests; default: arcClient() (null → tx checks are skipped, not failed) */
  client?: ReceiptClient | null;
  now?: number;
  /** per-tx receipt timeout */
  timeoutMs?: number;
}

// ─── Corroboration ───────────────────────────────────────────────────────────
export function domainOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}
export function isStrongDomain(host: string | null): boolean {
  if (!host) return false;
  return STRONG_URL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}
export function checkUrls(urls: string[]): UrlCorroboration[] {
  return urls.map((url) => { const domain = domainOf(url); return { url, domain, strong: isStrongDomain(domain) }; });
}

const pad32 = (a: Address) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;

/** Does a receipt touch the subject? from/to, a log emitted by the subject, or the subject as an indexed topic (Transfer from/to). */
export function receiptInvolves(receipt: { from?: string; to?: string | null; logs?: { address: string; topics: readonly string[] }[] }, subject: Address): boolean {
  const s = subject.toLowerCase();
  if (receipt.from?.toLowerCase() === s || receipt.to?.toLowerCase() === s) return true;
  const topic = pad32(subject);
  for (const log of receipt.logs ?? []) {
    if (log.address.toLowerCase() === s) return true;
    if (log.topics.some((t) => t.toLowerCase() === topic)) return true;
  }
  return false;
}

export async function checkTxs(hashes: `0x${string}`[], subject: Address, client: ReceiptClient | null, timeoutMs = 4_000): Promise<TxCorroboration[]> {
  const out: TxCorroboration[] = [];
  for (const hash of hashes) {
    if (!client) { out.push({ hash, found: false, involvesSubject: false, blockNumber: null }); continue; }
    try {
      const receipt = await Promise.race([
        client.getTransactionReceipt({ hash }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("receipt timeout")), timeoutMs)),
      ]);
      out.push({ hash, found: true, involvesSubject: receiptInvolves(receipt, subject), blockNumber: receipt.blockNumber == null ? null : Number(receipt.blockNumber) });
    } catch {
      out.push({ hash, found: false, involvesSubject: false, blockNumber: null }); // not found / RPC down → no corroboration
    }
  }
  return out;
}

// ─── Decision ────────────────────────────────────────────────────────────────
export function decide(tier: Verdict["tier"] | null, strong: number, weak: number): { decision: TipDecision; reason: string } {
  if (tier === "HIGH") return { decision: "VERIFIED", reason: `Re-screen is HIGH (${strong} strong, ${weak} weak corroboration).` };
  if (tier === "MEDIUM" && strong >= 1) return { decision: "VERIFIED", reason: `Re-screen is MEDIUM with ${strong} strong corroboration.` };
  if (tier === "LOW" && strong === 0 && weak === 0) return { decision: "REJECTED", reason: "Re-screen is LOW and the tip carries no corroboration." };
  if (tier == null) return { decision: "NEEDS_REVIEW", reason: "Re-screen unavailable; a human must look at the evidence." };
  return { decision: "NEEDS_REVIEW", reason: `Re-screen is ${tier} with ${strong} strong / ${weak} weak corroboration — not enough to verify or reject automatically.` };
}

/** Bounty = TIP_BOUNTY_USDC × category multiplier × (0.5 + 0.5 × reputation), 6 dp. */
export function bountyFor(category: TipCategory, reputation: number, baseUsdc = tipsEnv().bountyUsdc): number {
  const rep = Math.min(1, Math.max(0, reputation));
  return round6(baseUsdc * (CATEGORY_MULTIPLIER[category] ?? 1) * (0.5 + 0.5 * rep));
}

export function corroborationStrength(v: TipVerification): "strong" | "weak" {
  return v.corroboration.strong > 0 ? "strong" : "weak";
}

// ─── verifyTip ───────────────────────────────────────────────────────────────
export async function verifyTip(tip: Tip, opts: VerifyOptions = {}): Promise<TipVerification> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const doScreen = opts.screenFn ?? (pipelineScreen as ScreenFn);
  let client: ReceiptClient | null = opts.client === undefined ? null : opts.client;
  if (opts.client === undefined) { try { client = arcClient(); } catch { client = null; } }

  const urls = checkUrls(tip.evidenceUrls);
  const [txs, screened] = await Promise.all([
    checkTxs(tip.evidenceTxs, tip.subject, client, opts.timeoutMs),
    doScreen({ address: tip.subject, clientId: TIPS_CLIENT_ID }, { kind: "RESCREEN", writeOnChain: false })
      .then((v) => ({ v, error: null as string | null }))
      .catch((e: unknown) => ({ v: null as Verdict | null, error: (e as Error)?.message ?? String(e) })),
  ]);

  const strong = urls.filter((u) => u.strong).length + txs.filter((t) => t.found && t.involvesSubject).length;
  const weak = urls.filter((u) => !u.strong).length + txs.filter((t) => t.found && !t.involvesSubject).length;
  const v = screened.v;
  const { decision, reason } = decide(v?.tier ?? null, strong, weak);

  return {
    tier: v?.tier ?? null,
    score: v?.score ?? null,
    decisionId: v?.decisionId ?? null,
    reasonCodes: v ? v.reasons.map((r) => r.code) : [],
    corroboration: { txs, urls, strong, weak },
    decision,
    reason,
    by: "agent",
    verifiedAt: now,
    ...(screened.error ? { error: screened.error } : {}),
  };
}
