/**
 * Request parsing helpers. All validation goes through zod schemas from src/lib/types.
 * Failures throw `ApiError` (400) which `handle()` turns into `{ error: { code, message, details } }`.
 */
import type { z } from "zod";
import { AddressSchema, type Address } from "@/lib/types";
import { ApiError } from "./respond";

export interface Issue {
  path: string;
  message: string;
}

export function issuesOf(err: z.ZodError): Issue[] {
  return err.issues.map((i) => ({ path: i.path.map(String).join(".") || "(root)", message: i.message }));
}

/** Read and validate a JSON body. Empty body is treated as `{}` so required-field errors are reported by zod. */
export async function parseJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    const text = await req.text();
    raw = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new ApiError("INVALID_JSON", "Request body must be valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", "Request body failed validation", { issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}

/** Validate a path/query address. Returns the lowercased `0x…` address. */
export function parseAddress(value: string | undefined | null, field = "address"): Address {
  const parsed = AddressSchema.safeParse(value ?? "");
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", `Invalid EVM address in ${field}`, { issues: issuesOf(parsed.error) });
  }
  return parsed.data;
}

/** Parse an optional positive integer query param with bounds. */
export function parseLimit(url: URL, { def = 25, max = 100 }: { def?: number; max?: number } = {}): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new ApiError("VALIDATION_ERROR", "limit must be a positive integer", { issues: [{ path: "limit", message: `got ${raw}` }] });
  }
  return Math.min(n, max);
}

/** 1-based page number from ?page=; defaults to 1, clamped to [1, 100000]. */
export function parsePage(url: URL): number {
  const raw = Number(url.searchParams.get("page") ?? "1");
  if (!Number.isFinite(raw)) return 1;
  return Math.min(Math.max(Math.floor(raw), 1), 100_000);
}
