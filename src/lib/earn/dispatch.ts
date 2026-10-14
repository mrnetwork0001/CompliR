/**
 * Which revenue-yield backend runs: Circle Earn (default) or the legacy USYC Teller sweep (YIELD_BACKEND=usyc).
 * USYC is permissioned (Circle/Hashnote onboarding, ~100k minimum), so it stays available but is not the default.
 */
import { runSweepOnce, type SweepResult } from "../usyc/sweep";
import { runYieldOnce, type RunYieldOptions, type YieldResult } from "./sweep";

export type YieldBackend = "earn" | "usyc";
export function yieldBackend(): YieldBackend {
  return (process.env.YIELD_BACKEND ?? "earn").toLowerCase() === "usyc" ? "usyc" : "earn";
}

/** One revenue-yield tick on the configured backend. */
export async function runRevenueYieldOnce(opts: RunYieldOptions & { runUsyc?: () => Promise<SweepResult> } = {}): Promise<YieldResult | (SweepResult & { backend: "usyc" })> {
  if (yieldBackend() === "usyc") {
    const prev = process.env.USYC_FLOAT_USDC;
    if (opts.floatUsdc != null) process.env.USYC_FLOAT_USDC = String(opts.floatUsdc);
    try { return { backend: "usyc", ...(await (opts.runUsyc ?? runSweepOnce)()) }; }
    finally { if (prev === undefined) delete process.env.USYC_FLOAT_USDC; else process.env.USYC_FLOAT_USDC = prev; }
  }
  return runYieldOnce(opts);
}
