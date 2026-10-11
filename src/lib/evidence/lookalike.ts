/**
 * Address-poisoning / lookalike detection against the client's payee book, and payee-change detection.
 *
 * A subject is a lookalike of a payee when (a) it shares the first 4 and last 4 hex characters (what wallets
 * display as "0x1234…abcd") but is a different address, or (b) normalized Levenshtein similarity over the 40
 * hex chars is ≥ 0.8. `similarity` is max(levenshtein similarity, 1.0 if the truncated display is identical).
 */
import type { Address, PayeeBookEntry } from "../types";
import { lower } from "./util";

export interface Lookalike {
  payeeLabel: string;
  payeeAddress: Address;
  similarity: number;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const hex = (a: string) => lower(a).slice(2);

/** 1 − lev/40 over the hex body */
export function levenshteinSimilarity(a: string, b: string): number {
  const x = hex(a);
  const y = hex(b);
  const n = Math.max(x.length, y.length) || 1;
  return 1 - levenshtein(x, y) / n;
}

export function sharesAffixes(a: string, b: string, n = 4): boolean {
  const x = hex(a);
  const y = hex(b);
  return x !== y && x.slice(0, n) === y.slice(0, n) && x.slice(-n) === y.slice(-n);
}

export interface LookalikeOptions {
  minSimilarity?: number; // default 0.8
  affixLength?: number; // default 4
}

export function findLookalikes(subject: Address, payeeBook: PayeeBookEntry[] | undefined, opts: LookalikeOptions = {}): Lookalike[] {
  const min = opts.minSimilarity ?? 0.8;
  const n = opts.affixLength ?? 4;
  const subj = lower(subject);
  const out: Lookalike[] = [];
  for (const p of payeeBook ?? []) {
    const addr = lower(p.address);
    if (addr === subj) continue;
    const lev = levenshteinSimilarity(subj, addr);
    const affix = sharesAffixes(subj, addr, n);
    if (!affix && lev < min) continue;
    out.push({ payeeLabel: p.label, payeeAddress: addr, similarity: Math.round(Math.max(lev, affix ? 1 : 0) * 1000) / 1000 });
  }
  return out.sort((a, b) => b.similarity - a.similarity || a.payeeAddress.localeCompare(b.payeeAddress));
}

const normLabel = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * "Same payee name, new address": the subject is listed under a label in the current book, and the previous
 * book had that label pointing at a different address.
 */
export function detectPayeeChange(
  subject: Address,
  payeeBook: PayeeBookEntry[] | undefined,
  previousBook: PayeeBookEntry[] | undefined,
): { payeeLabel: string; previousAddress: Address } | null {
  if (!payeeBook?.length || !previousBook?.length) return null;
  const subj = lower(subject);
  const prevByLabel = new Map<string, PayeeBookEntry>();
  for (const p of previousBook) prevByLabel.set(normLabel(p.label), p);
  for (const p of payeeBook) {
    if (lower(p.address) !== subj) continue;
    const prev = prevByLabel.get(normLabel(p.label));
    if (prev && lower(prev.address) !== subj) return { payeeLabel: p.label, previousAddress: lower(prev.address) };
  }
  return null;
}
