/**
 * Browser-side helpers shared by the pages: typed fetch against our own /api/v1, explorer link builders,
 * and small formatters. All relative URLs - works behind any host.
 */
import type { Tier } from "@/lib/types";
import type { HealthResponse } from "@/app/api/_lib/public-types";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new HttpError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return body as T;
}

export async function postJson<T>(path: string, data: unknown): Promise<T> {
  return apiFetch<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}

let healthCache: Promise<HealthResponse> | null = null;
/** Cached per page-load; health is cheap but we call it from several components. */
export function getHealth(): Promise<HealthResponse> {
  if (!healthCache) {
    healthCache = fetch("/api/v1/health", { cache: "no-store" })
      .then((r) => r.json() as Promise<HealthResponse>)
      .catch(() => {
        healthCache = null;
        return {
          ok: false,
          chainId: null,
          network: { chainId: null, explorerUrl: "", usdcAddress: null, registryAddress: null, protocolBlocklistAddress: null },
          paused: true,
          x402: { disabled: true, priceScreenUsdc: 0, priceWatchUsdc: 0 },
          examples: [],
          time: new Date().toISOString(),
          error: "health unreachable",
        } satisfies HealthResponse;
      });
  }
  return healthCache;
}

export const TX_RE = /^0x[0-9a-fA-F]{64}$/;
export const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function txUrl(explorerUrl: string, hash: string): string | null {
  return explorerUrl ? `${explorerUrl.replace(/\/$/, "")}/tx/${hash}` : null;
}
export function addressUrl(explorerUrl: string, addr: string): string | null {
  return explorerUrl ? `${explorerUrl.replace(/\/$/, "")}/address/${addr}` : null;
}

export function short(hex: string, head = 6, tail = 4): string {
  return hex.length > head + tail + 2 ? `${hex.slice(0, head)}…${hex.slice(-tail)}` : hex;
}

export function fmtTime(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined) return "-";
  const d = typeof iso === "number" ? new Date(iso * (iso < 1e12 ? 1000 : 1)) : new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function fmtRelative(iso: string | number): string {
  const d = typeof iso === "number" ? new Date(iso * (iso < 1e12 ? 1000 : 1)) : new Date(iso);
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "second"],
    [3600, "minute"],
    [86400, "hour"],
    [604800, "day"],
    [Infinity, "week"],
  ];
  let value = diff;
  let unit: Intl.RelativeTimeFormatUnit = "second";
  let prev = 1;
  for (const [limit, u] of units) {
    unit = u;
    value = diff / prev;
    if (abs < limit) break;
    prev = limit;
  }
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(value), unit);
}

export function fmtUsdc(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " USDC";
}

export const TIER_LABEL: Record<Tier, string> = { LOW: "Low risk", MEDIUM: "Medium risk", HIGH: "High risk" };
export const TIER_ACTION: Record<Tier, string> = { LOW: "Pay", MEDIUM: "Pay with limits", HIGH: "Hold" };
