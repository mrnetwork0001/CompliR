/**
 * Demo seed so /map is never empty while the tailer warms up. Inserts the three demo addresses the Explorer
 * already uses (…dead HIGH, …beef MEDIUM, …cafe LOW) with fake edges + one fake tier change. Everything is
 * flagged source='demo' so the UI can say so and never links a made-up tx hash to the explorer.
 * Called from tailOnce() when trustmap_nodes is empty and TRUSTMAP_SEED_DEMO=1.
 */
import type { Address, ReasonCode, Tier } from "../types";
import { db } from "../store/db";
import { addInflow, countNodes, insertEdges, insertTierChange, migrateTrustmap, setMeta, upsertNode } from "./store";

export const DEMO_ADDRESSES = {
  HIGH: "0x000000000000000000000000000000000000dead" as Address,
  MEDIUM: "0x000000000000000000000000000000000000beef" as Address,
  LOW: "0x000000000000000000000000000000000000cafe" as Address,
} as const;

const demoTx = (n: number) => `0x${"de".repeat(4)}${n.toString(16).padStart(56, "0")}` as `0x${string}`;

const DEMO_NODES: { address: Address; tier: Tier; score: number; usdc: number; codes: ReasonCode[]; rationale: string }[] = [
  { address: DEMO_ADDRESSES.HIGH, tier: "HIGH", score: 92, usdc: 18_400, codes: ["SANCTIONS_DIRECT", "FUNDER_1HOP_BLACKLISTED"], rationale: "Demo override: direct sanctions hit and a blacklisted funder one hop away. Hold payments." },
  { address: DEMO_ADDRESSES.MEDIUM, tier: "MEDIUM", score: 44, usdc: 2_350, codes: ["FRESH_WALLET", "FUNDER_2HOP_SANCTIONED"], rationale: "Demo override: fresh wallet with a sanctioned party two hops upstream. Pay with limits." },
  { address: DEMO_ADDRESSES.LOW, tier: "LOW", score: 4, usdc: 610, codes: ["CLEAN"], rationale: "Demo override: no sanctions, blacklist or funder-graph signals. Pay." },
];

export async function seedDemo(opts: { now?: number; block?: number; force?: boolean } = {}): Promise<{ seeded: boolean; nodes: number }> {
  await migrateTrustmap();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const block = opts.block ?? 0;
  if (!opts.force) {
    const c = await countNodes();
    if (c.graded > 0) return { seeded: false, nodes: c.graded };
  }
  for (const n of DEMO_NODES) {
    await upsertNode({ address: n.address, tier: n.tier, score: n.score, lastSeenBlock: block, usdcIn24h: n.usdc, reasonCodes: n.codes, rationale: n.rationale, decisionId: null, source: "demo", at: now - 3600 });
    await addInflow(n.address, block, n.usdc, now - 3600);
  }
  await insertEdges(
    [
      { from: DEMO_ADDRESSES.HIGH, to: DEMO_ADDRESSES.MEDIUM, usdc: 1_200, txHash: demoTx(1), block, source: "demo" },
      { from: DEMO_ADDRESSES.MEDIUM, to: DEMO_ADDRESSES.LOW, usdc: 350, txHash: demoTx(2), block, source: "demo" },
      { from: DEMO_ADDRESSES.LOW, to: DEMO_ADDRESSES.HIGH, usdc: 80, txHash: demoTx(3), block, source: "demo" },
      { from: DEMO_ADDRESSES.HIGH, to: DEMO_ADDRESSES.LOW, usdc: 25, txHash: demoTx(4), block, source: "demo" },
    ],
    now - 3600,
  );
  // one demo regrade so the ticker has something to show
  await insertTierChange({ address: DEMO_ADDRESSES.MEDIUM, from: "LOW", to: "MEDIUM", score: 44, block, decisionId: null, at: now - 1800, source: "demo" });
  await db().execute({ sql: `UPDATE trustmap_nodes SET prev_tier = 'LOW', changed_at = ? WHERE address = ?`, args: [now - 1800, DEMO_ADDRESSES.MEDIUM] });
  await setMeta("seeded_at", String(now));
  return { seeded: true, nodes: DEMO_NODES.length };
}
