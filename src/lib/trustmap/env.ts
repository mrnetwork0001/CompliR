/**
 * Arc Trust Map tunables. Read straight from process.env (config.ts is owned by the lead).
 * Every key is optional. Add to .env.example:
 *
 *   # ── Arc Trust Map (chain-wide tailer; worker/trustmap.ts or POST /api/internal/trustmap) ──
 *   # TRUSTMAP_MIN_USDC=25          # a recipient must receive at least this much USDC in the scanned window to be graded
 *   # TRUSTMAP_REGRADE_HOURS=24     # a node graded more recently than this is skipped (regrade window)
 *   # TRUSTMAP_MAX_PER_TICK=5       # max counterparties graded per tick (each grade = one full pipeline screen)
 *   # TRUSTMAP_MAX_BLOCKS=200       # blocks tailed per tick (Arc ≈ 2 blocks/s → 200 ≈ 100 s of chain)
 *   # TRUSTMAP_MAX_LAG=2000         # if the cursor is further behind head than this, skip ahead (live view, not an indexer)
 *   # TRUSTMAP_RPC_BUDGET=24        # max RPC calls per tick for the tailer itself (getBlockNumber + getLogs + getCode)
 *   # TRUSTMAP_SEED_DEMO=0          # 1 → seed the three demo addresses (…dead/…beef/…cafe) when the table is empty
 *   # TRUSTMAP_TICK_MS=30000        # worker loop interval
 */
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined) => /^(1|true|yes|on)$/i.test((v ?? "").trim());

export function trustmapEnv() {
  const e = process.env;
  return {
    minUsdc: num(e.TRUSTMAP_MIN_USDC, 25),
    regradeHours: num(e.TRUSTMAP_REGRADE_HOURS, 24),
    maxPerTick: Math.max(0, Math.floor(num(e.TRUSTMAP_MAX_PER_TICK, 5))),
    maxBlocks: Math.max(1, Math.floor(num(e.TRUSTMAP_MAX_BLOCKS, 200))),
    maxLag: Math.max(1, Math.floor(num(e.TRUSTMAP_MAX_LAG, 2000))),
    rpcBudget: Math.max(3, Math.floor(num(e.TRUSTMAP_RPC_BUDGET, 24))),
    seedDemo: bool(e.TRUSTMAP_SEED_DEMO),
    tickMs: Math.max(5_000, num(e.TRUSTMAP_TICK_MS, 30_000)),
  };
}
