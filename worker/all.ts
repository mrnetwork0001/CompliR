/** Runs every CompliR worker loop in one process (for a VM/container): watcher, trustmap, treasury, operator, events, tips, usyc, report. */
import { runWatcherOnce } from "../src/lib/watcher";
import { tailOnce } from "../src/lib/trustmap/tailer";
import { runTreasuryOnce } from "../src/lib/treasury/agent";
import { runOperatorOnce } from "../src/lib/operator/run";
import { pollBlocklistEvents } from "../src/lib/events/blocklist";
import { runTipsOnce } from "../src/lib/tips";
import { runSweepOnce } from "../src/lib/usyc/sweep";
import { publishReport } from "../src/lib/reports";
import { processRefunds, installRefundSink } from "../src/lib/refunds";

type Job = { name: string; everyMs: number; run: () => Promise<unknown> };
const jobs: Job[] = [
  { name: "watcher", everyMs: 60_000, run: runWatcherOnce },
  { name: "trustmap", everyMs: 30_000, run: () => tailOnce({}) },
  { name: "events", everyMs: 20_000, run: () => pollBlocklistEvents({}) },
  { name: "treasury", everyMs: 60_000, run: runTreasuryOnce },
  { name: "operator", everyMs: 3_600_000, run: runOperatorOnce },
  { name: "tips", everyMs: 300_000, run: runTipsOnce },
  { name: "refunds", everyMs: 300_000, run: processRefunds },
  { name: "usyc", everyMs: 3_600_000, run: runSweepOnce },
  { name: "report", everyMs: 3_600_000, run: () => publishReport(new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)) },
];
installRefundSink();
for (const job of jobs) {
  const loop = async () => {
    const t0 = Date.now();
    try { const r = await job.run(); console.log(`[${job.name}] ${new Date().toISOString()} ${Date.now() - t0}ms`, JSON.stringify(r)?.slice(0, 200)); }
    catch (e) { console.error(`[${job.name}] failed`, (e as Error)?.message); }
    setTimeout(loop, job.everyMs);
  };
  setTimeout(loop, 1000 + Math.random() * 5000);
}
console.log("[complir-workers] started", jobs.map((j) => j.name).join(", "));
