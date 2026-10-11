/**
 * Self-hosted yente (OpenSanctions) matcher. POST {YENTE_URL}/match/{dataset}
 * Docs: https://www.opensanctions.org/docs/api/matching/ , /docs/api/request/ , /docs/api/response/
 *   body   { queries: { <key>: { schema, properties: { <prop>: string[] } } } }
 *   params threshold (default 0.7 — scores at/above count as `match`), limit (default 5), algorithm
 *   reply  { responses: { <key>: { status, results: [{ id, caption, schema, datasets, score, match, … }] } } }
 * Names are matched as Person, Company and LegalEntity; addresses as CryptoWallet.publicKey (both lowercase
 * and EIP-55 spellings are sent). yente unreachable / non-2xx / timeout → [] (never throws).
 */
import { getAddress } from "viem";
import type { Address, SanctionsHit } from "../types";
import { config } from "../config";
import { evidenceEnv } from "./env";
import { lower } from "./util";

export interface YenteOptions {
  baseUrl?: string;
  dataset?: string;
  threshold?: number;
  limit?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface YenteSubject {
  address?: Address;
  name?: string;
}

export const NAME_SCHEMAS = ["Person", "Company", "LegalEntity"] as const;

interface YenteResult {
  id: string;
  caption?: string;
  schema?: string;
  datasets?: string[];
  score?: number;
  match?: boolean;
}
interface YenteResponse {
  responses?: Record<string, { status?: number; results?: YenteResult[] }>;
}

export function toSanctionsHit(r: YenteResult, matchedOn: SanctionsHit["matchedOn"]): SanctionsHit {
  return {
    source: "opensanctions",
    entityId: r.id,
    caption: r.caption ?? r.id,
    datasets: Array.isArray(r.datasets) ? [...r.datasets] : [],
    score: typeof r.score === "number" ? r.score : 0,
    matchedOn,
  };
}

function resolve(opts: YenteOptions) {
  const env = evidenceEnv();
  let baseUrl = opts.baseUrl;
  if (!baseUrl) {
    try {
      baseUrl = config().YENTE_URL;
    } catch {
      baseUrl = "http://localhost:8000";
    }
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    dataset: opts.dataset ?? env.yenteDataset,
    threshold: opts.threshold ?? env.yenteThreshold,
    limit: opts.limit ?? 5,
    timeoutMs: opts.timeoutMs ?? env.sourceTimeoutMs,
    fetchImpl: opts.fetchImpl ?? globalThis.fetch,
  };
}

function addressSpellings(a: Address): string[] {
  const l = lower(a);
  try {
    const c = getAddress(a);
    return c === l ? [l] : [l, c];
  } catch {
    return [l];
  }
}

/** Builds one batched /match request for many subjects; returns hits per subject index. */
export async function yenteMatch(subjects: YenteSubject[], opts: YenteOptions = {}): Promise<SanctionsHit[][]> {
  const out: SanctionsHit[][] = subjects.map(() => []);
  const { baseUrl, dataset, threshold, limit, timeoutMs, fetchImpl } = resolve(opts);
  const queries: Record<string, { schema: string; properties: Record<string, string[]> }> = {};
  subjects.forEach((s, i) => {
    if (s.address) queries[`a:${i}`] = { schema: "CryptoWallet", properties: { publicKey: addressSpellings(s.address) } };
    const name = s.name?.trim();
    if (name) for (const schema of NAME_SCHEMAS) queries[`n:${i}:${schema}`] = { schema, properties: { name: [name] } };
  });
  if (Object.keys(queries).length === 0 || !fetchImpl) return out;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let body: YenteResponse;
  try {
    const url = `${baseUrl}/match/${encodeURIComponent(dataset)}?threshold=${threshold}&limit=${limit}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ queries }),
      signal: ctrl.signal,
    });
    if (!res.ok) return out;
    body = (await res.json()) as YenteResponse;
  } catch {
    return out; // yente down, DNS, timeout, bad JSON → no evidence, not an error
  } finally {
    clearTimeout(t);
  }

  const best = subjects.map(() => new Map<string, SanctionsHit>());
  for (const [key, resp] of Object.entries(body.responses ?? {})) {
    const [kind, idx] = key.split(":");
    const i = Number(idx);
    if (!Number.isInteger(i) || !best[i]) continue;
    const matchedOn: SanctionsHit["matchedOn"] = kind === "a" ? "address" : "name";
    for (const r of resp.results ?? []) {
      if (!r?.id) continue;
      const score = typeof r.score === "number" ? r.score : 0;
      if (!(r.match === true || score >= threshold)) continue;
      const hit = toSanctionsHit(r, matchedOn);
      const prev = best[i].get(hit.entityId);
      // address matches outrank name matches; otherwise keep the higher score
      if (!prev || (prev.matchedOn !== "address" && hit.matchedOn === "address") || (prev.matchedOn === hit.matchedOn && hit.score > prev.score)) {
        best[i].set(hit.entityId, hit);
      }
    }
  }
  return best.map((m) => [...m.values()].sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId)));
}

export async function screenSanctions(subject: YenteSubject, opts: YenteOptions = {}): Promise<SanctionsHit[]> {
  const [hits] = await yenteMatch([subject], opts);
  return hits ?? [];
}

/** Address-only screening for a list of wallets, chunked to yente's default YENTE_MAX_BATCH (100). */
export async function screenAddresses(addresses: Address[], opts: YenteOptions = {}): Promise<Map<Address, SanctionsHit[]>> {
  const uniq = [...new Set(addresses.map(lower))];
  const result = new Map<Address, SanctionsHit[]>(uniq.map((a) => [a, []]));
  for (let i = 0; i < uniq.length; i += 100) {
    const batch = uniq.slice(i, i + 100);
    const hits = await yenteMatch(batch.map((address) => ({ address })), opts);
    batch.forEach((a, j) => result.set(a, hits[j] ?? []));
  }
  return result;
}
