import { z } from "zod";

/** "1" | "true" | "yes" | "on" → true; anything else (incl. "0", "false", unset) → false. */
const boolish = z
  .union([z.string(), z.boolean()])
  .optional()
  .transform((v) => (typeof v === "boolean" ? v : /^(1|true|yes|on)$/i.test((v ?? "").trim())));

/** All network + service config is env-driven. Nothing hard-coded. See .env.example. */
const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Arc
  ARC_CHAIN_ID: z.coerce.number().int().positive(),
  ARC_RPC_URL: z.string().url(),
  ARC_EXPLORER_URL: z.string().url().default("https://explorer.arc.network"),
  ARC_BLOCKSCOUT_API: z.string().url().optional(),
  USDC_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  REGISTRY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  PROTOCOL_BLOCKLIST_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  // Keys
  ATTESTER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANALYST_MODEL: z.string().default("claude-sonnet-5-5"),
  // Data
  YENTE_URL: z.string().url().default("http://localhost:8000"),
  DATABASE_URL: z.string().default("file:./.data/complir.db"),
  DATABASE_AUTH_TOKEN: z.string().optional(),
  // Payments
  X402_DISABLED: boolish,
  X402_NETWORK: z.string().optional(),
  X402_PAY_TO: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  X402_FACILITATOR_URL: z.string().url().optional(),
  PRICE_SCREEN_USDC: z.coerce.number().default(0.01),
  PRICE_WATCH_USDC: z.coerce.number().default(0.05),
  // Ops
  COMPLIR_PAUSED: boolish,
  ANCHOR_EVERY_N: z.coerce.number().int().positive().default(50),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  // Circle Developer-Controlled Wallets + Gas Station (src/lib/circle, docs/CIRCLE_WALLETS.md). All optional:
  // without CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET every Circle call is a reported dry-run and SIGNER_MODE=circle falls back to local.
  SIGNER_MODE: z.enum(["local", "circle"]).default("local"),
  CIRCLE_API_KEY: z.string().optional(),
  CIRCLE_ENTITY_SECRET: z.string().optional(), // 32-byte hex from `generateEntitySecret()`; validated in src/lib/circle/client.ts
  CIRCLE_BASE_URL: z.string().url().optional(),
  CIRCLE_WALLET_SET_ID: z.string().optional(),
  CIRCLE_WALLET_SET_NAME: z.string().default("complir"),
  CIRCLE_ACCOUNT_TYPE: z.enum(["SCA", "EOA"]).default("SCA"),
  CIRCLE_FEE_LEVEL: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
  CIRCLE_TX_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  CIRCLE_OPS_POLICY_PER_TX_USDC: z.coerce.number().nonnegative().default(1),
  CIRCLE_OPS_POLICY_DAILY_USDC: z.coerce.number().nonnegative().default(10),
  CIRCLE_OPS_POLICY_ALLOWLIST: z.string().optional(),
  CIRCLE_REVENUE_POLICY_PER_TX_USDC: z.coerce.number().nonnegative().default(25),
  CIRCLE_REVENUE_POLICY_DAILY_USDC: z.coerce.number().nonnegative().default(100),
  CIRCLE_REVENUE_POLICY_ALLOWLIST: z.string().optional(),
});
export type Config = z.infer<typeof Env>;

let cached: Config | null = null;
export function config(): Config {
  if (cached) return cached;
  // Treat blank env values ("") as unset so optional fields validate.
  const raw: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) raw[k] = v === "" ? undefined : v;
  const parsed = Env.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Invalid environment:\n" + JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  }
  cached = parsed.data;
  return cached;
}
/** test helper */
export function __resetConfig() {
  cached = null;
}
