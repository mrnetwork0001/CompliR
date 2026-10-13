/**
 * Local evidence overrides - merged OVER live facts for specific addresses.
 *
 * Purpose: demo HIGH / MEDIUM verdicts on wallets WE control. We must never pay (or test against) a real
 * sanctioned address (spec §4). Source: env OVERRIDES_JSON (inline JSON) or the file OVERRIDES_PATH
 * (default .data/overrides.json). Shape:
 *   { [address]: { sanctions?, usdcBlacklisted?, protocolBlocklisted?, firstSeen?, txCount?,
 *                  funders?: { hop, path, facts }[], note? } }
 * `funders` replaces the chain trace for that subject; its entries' `facts` may be partial (address required).
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Address, AddressFacts } from "../types";
import type { FunderEntry } from "./arcGraph";
import { evidenceEnv } from "./env";
import { lower } from "./util";

const Addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase() as Address);
const Hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase() as `0x${string}`);

export const SanctionsHitSchema = z.object({
  source: z.literal("opensanctions").default("opensanctions"),
  entityId: z.string().min(1),
  caption: z.string().min(1),
  datasets: z.array(z.string()).default([]),
  score: z.number().min(0).max(1),
  matchedOn: z.enum(["address", "name"]),
});

export const FactsOverrideSchema = z.object({
  sanctions: z.array(SanctionsHitSchema).optional(),
  usdcBlacklisted: z.boolean().optional(),
  protocolBlocklisted: z.boolean().optional(),
  firstSeen: z.number().int().nullable().optional(),
  txCount: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
});

const FunderHopSchema = z.object({
  from: Addr,
  to: Addr,
  txHash: Hash,
  amountUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
  timestamp: z.number().int().nonnegative(),
});

export const FunderOverrideSchema = z.object({
  hop: z.union([z.literal(1), z.literal(2)]),
  path: z.array(FunderHopSchema).min(1),
  facts: FactsOverrideSchema.extend({ address: Addr }),
});

export const OverrideSchema = FactsOverrideSchema.extend({
  funders: z.array(FunderOverrideSchema).optional(),
});
export const OverridesFileSchema = z.record(z.string(), OverrideSchema);

export type FactsOverride = z.infer<typeof FactsOverrideSchema>;
export type Override = z.infer<typeof OverrideSchema>;
export type Overrides = Record<Address, Override>;

/** Validate + lowercase keys. Throws on malformed input (callers decide whether that is fatal). */
export function parseOverrides(raw: unknown): Overrides {
  const parsed = OverridesFileSchema.parse(raw);
  const out: Overrides = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(k)) throw new Error(`overrides: bad address key ${k}`);
    out[lower(k)] = v;
  }
  return out;
}

let cache: { key: string; mtimeMs: number; value: Overrides } | null = null;

/** Env JSON wins over the file. Missing file → {}. Malformed input → {} with a console.warn (never throws). */
export function loadOverrides(opts: { json?: string | null; filePath?: string | null } = {}): Overrides {
  const env = evidenceEnv();
  const json = opts.json === undefined ? env.overridesJson : opts.json;
  try {
    if (json) {
      if (cache?.key === `json:${json}`) return cache.value;
      const value = parseOverrides(JSON.parse(json));
      cache = { key: `json:${json}`, mtimeMs: 0, value };
      return value;
    }
    if (opts.filePath === null) return {};
    const file = path.resolve(process.cwd(), opts.filePath ?? env.overridesPath);
    if (!fs.existsSync(file)) return {};
    const mtimeMs = fs.statSync(file).mtimeMs;
    if (cache?.key === `file:${file}` && cache.mtimeMs === mtimeMs) return cache.value;
    const value = parseOverrides(JSON.parse(fs.readFileSync(file, "utf8")));
    cache = { key: `file:${file}`, mtimeMs, value };
    return value;
  } catch (err) {
    console.warn("[evidence/overrides] ignoring malformed overrides:", (err as Error).message);
    return {};
  }
}

export function __resetOverridesCache() {
  cache = null;
}

/** Fields present in the override replace the live value; everything else is kept. */
export function applyFactsOverride(facts: AddressFacts, o: FactsOverride | undefined): AddressFacts {
  if (!o) return facts;
  return {
    ...facts,
    sanctions: o.sanctions ?? facts.sanctions,
    usdcBlacklisted: o.usdcBlacklisted ?? facts.usdcBlacklisted,
    protocolBlocklisted: o.protocolBlocklisted ?? facts.protocolBlocklisted,
    firstSeen: o.firstSeen === undefined ? facts.firstSeen : o.firstSeen,
    txCount: o.txCount ?? facts.txCount,
  };
}

/** Override funders → FunderEntry[] with complete facts (partial facts filled with safe defaults). */
export function fundersFromOverride(o: Override | undefined): FunderEntry[] | null {
  if (!o?.funders) return null;
  return o.funders.map((f) => ({
    hop: f.hop,
    path: f.path,
    facts: applyFactsOverride(
      { address: f.facts.address, firstSeen: null, txCount: 0, usdcBlacklisted: false, protocolBlocklisted: false, sanctions: [] },
      f.facts,
    ),
  }));
}
