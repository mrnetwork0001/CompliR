/** CCTP inbound-screening tunables, straight from process.env (see docs/CCTP.md). */
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};
export function cctpEnv() {
  const e = process.env;
  return {
    /** only inbound mints of at least this many USDC are screened */
    minUsdc: num(e.CCTP_MIN_USDC, 100),
    /** first tick starts this many blocks behind head (≈ 2 blocks/s on Arc) */
    lookbackBlocks: num(e.CCTP_LOOKBACK_BLOCKS, 3_000),
    /** blocks per tick (public RPC caps getLogs at 10_000) */
    maxBlocks: Math.min(9_999, num(e.CCTP_MAX_BLOCKS, 9_999)),
    /** full-pipeline recipient screens per tick (each is an attested, ledgered screen with an analyst call) */
    maxScreens: num(e.CCTP_MAX_SCREENS, 5),
    /** reuse the recipient's last cctp verdict if it is younger than this */
    rescreenHours: num(e.CCTP_RESCREEN_HOURS, 6),
    /** if the cursor is further behind head than this, skip ahead (live reactor, not an indexer) */
    maxLag: num(e.CCTP_MAX_LAG, 50_000),
    /** per-source timeout for sender checks (yente / source-chain RPC) */
    timeoutMs: num(e.CCTP_SOURCE_TIMEOUT_MS, 4_000),
    /** INBOUND_FLAGGED lookback */
    windowDays: num(e.CCTP_WINDOW_DAYS, 30),
    messageTransmitter: /^0x[0-9a-fA-F]{40}$/.test(e.CCTP_MESSAGE_TRANSMITTER ?? "") ? (e.CCTP_MESSAGE_TRANSMITTER as `0x${string}`) : null,
  };
}
