/**
 * Long-running CCTP inbound-screening loop: every 60 s tail Arc's MessageTransmitterV2 for inbound mints, screen the
 * source-chain sender + the Arc recipient, and keep the ERC-8004 agent index fresh.
 * (Not for Vercel serverless; there use a cron → /api/internal/cctp.)
 * Run: `npx tsx --env-file=.env.local worker/cctp.ts`
 */
import { tailCctpOnce } from "../src/lib/cctp/tailer";
import { syncAgentIndex } from "../src/lib/erc8004/indexer";

const EVERY_MS = 60_000;

const loop = async () => {
  try {
    const r = await tailCctpOnce();
    console.log("[cctp]", new Date().toISOString(), { blocks: `${r.fromBlock}-${r.toBlock}`, logs: r.logs, mints: r.mints, recorded: r.recorded, screened: r.screened, reused: r.reused, flagged: r.flagged, partial: r.partial, error: r.error, ms: r.ms });
  } catch (e) {
    console.error("[cctp] tick failed", (e as Error)?.message);
  }
  try {
    const s = await syncAgentIndex();
    if (s.agentsTouched || s.error) console.log("[erc8004] index", { blocks: `${s.fromBlock}-${s.toBlock}`, touched: s.agentsTouched, partial: s.partial, error: s.error });
  } catch (e) {
    console.error("[erc8004] index sync failed", (e as Error)?.message);
  }
  setTimeout(loop, EVERY_MS);
};
loop();
