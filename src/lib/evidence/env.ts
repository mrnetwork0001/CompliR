/**
 * Evidence-collector tunables. Read straight from process.env (config.ts is owned by the lead and
 * only carries the shared network keys). Every key is optional and documented in .env.example.
 */
import type { Address } from "../types";

/** Arc system emitter: logs a Transfer(from,to,value) (18 dp) for EVERY USDC movement (EIP-7708). */
export const ARC_SYSTEM_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe" as Address; // 0xffff…fffE
/** USDC ERC-20 interface (NativeFiatTokenV2 proxy, 6 dp) - same address on Arc mainnet and testnet. */
export const ARC_USDC_ERC20 = "0x3600000000000000000000000000000000000000" as Address;

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) ? n : d;
};

export function evidenceEnv() {
  const e = process.env;
  const emitter = (e.ARC_USDC_EMITTER?.toLowerCase() as Address | undefined) || ARC_SYSTEM_EMITTER;
  return {
    /** contract whose Transfer logs we trace (default: system emitter, 18 dp) */
    emitter,
    /** decimals of `value` in those logs: 18 for the system emitter, 6 for the ERC-20 contract */
    emitterDecimals: num(e.ARC_USDC_EMITTER_DECIMALS, emitter === ARC_USDC_ERC20 ? 6 : 18),
    /** how far back (blocks) the funder trace looks. ~2 blocks/s on Arc → 20_000 ≈ 2.8 h = 3 getLogs chunks per wallet */
    lookbackBlocks: num(e.EVIDENCE_LOOKBACK_BLOCKS, 20_000),
    /** eth_getLogs chunk; public Arc RPC caps a range at 10_000 blocks (-32012) */
    chunkBlocks: Math.min(9_999, num(e.EVIDENCE_GETLOGS_CHUNK, 9_999)),
    /** per-source timeout (spec: 4 s) */
    sourceTimeoutMs: num(e.EVIDENCE_SOURCE_TIMEOUT_MS, 4_000),
    /** yente dataset segment of POST /match/{dataset} */
    yenteDataset: e.YENTE_DATASET || "default",
    /** matcher score needed for a name hit to be reported (address hits are reported at any score ≥ this too) */
    yenteThreshold: num(e.YENTE_THRESHOLD, 0.7),
    overridesJson: e.OVERRIDES_JSON,
    overridesPath: e.OVERRIDES_PATH || ".data/overrides.json",
  };
}
