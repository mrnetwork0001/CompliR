#!/usr/bin/env node
// Live smoke test against a running CompliR (local or hosted). Usage:
//   node --env-file=.env.local scripts/go-live-check.mjs [baseUrl]
// Checks health/signer/registry, performs one real screen, waits for the registry tx, runs a treasury tick,
// anchors if due, and prints explorer links. Exit code 1 on any hard failure.
const base = process.argv[2] || process.env.PUBLIC_BASE_URL || "http://localhost:3000";
const secret = process.env.CRON_SECRET;
const explorer = process.env.ARC_EXPLORER_URL || "https://explorer.arc.io";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (path, init) => { const r = await fetch(base + path, init); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { status: r.status, body: b }; };
let failed = 0; const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failed++; };

const h = await j("/api/v1/health");
ok(h.status === 200 && h.body.ok, `health ${h.status} ok=${h.body?.ok}`);
ok(h.body?.chainId === 5042, `chain ${h.body?.chainId} (expect 5042 mainnet)`);
ok(!!h.body?.network?.registryAddress, `registry configured: ${h.body?.network?.registryAddress ?? "MISSING"}`);
console.log(`  signer: ${JSON.stringify(h.body?.signer?.mode)} · x402 disabled=${h.body?.x402?.disabled} · paused=${h.body?.paused}`);

// one real screen of the demo MEDIUM address (same-origin header keeps it free on this host)
const addr = "0x000000000000000000000000000000000000beef";
const s = await j("/api/v1/screen", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ address: addr, amountUsdc: 25, clientId: "go-live-check" }) });
ok(s.status === 200, `screen ${s.status} → ${s.body?.tier} ${s.body?.score} decision ${s.body?.decisionId}`);
let tx = null;
for (let i = 0; i < 20 && !tx; i++) { await sleep(3000); const a = await j(`/api/v1/attestation/${addr}`); tx = a.body?.attestation?.registryTx ?? null; }
ok(!!tx, tx ? `registry attest tx ${explorer}/tx/${tx}` : "registry tx not seen in 60 s (REGISTRY_ADDRESS/ATTESTER_PRIVATE_KEY set? attester funded?)");

if (secret) {
  const t = await j("/api/internal/treasury", { method: "POST", headers: { authorization: `Bearer ${secret}` } });
  ok(t.status === 200, `treasury tick ${t.status} mode=${t.body?.mode} processed=${t.body?.processed} paid=${t.body?.paid} limited=${t.body?.limited} held=${t.body?.held}`);
  const w = await j("/api/internal/watcher", { method: "POST", headers: { authorization: `Bearer ${secret}` } });
  ok(w.status === 200, `watcher tick ${w.status} anchor=${JSON.stringify(w.body?.anchor)}`);
  const p = await j("/api/v1/payouts");
  for (const inv of p.body?.invoices ?? p.body?.items ?? []) if (inv.txHash) console.log(`  payout ${inv.status} ${inv.paidUsdc} USDC ${explorer}/tx/${inv.txHash}`);
} else console.log("  (set CRON_SECRET to also run treasury/watcher ticks)");

const v = await j("/api/v1/ledger/verify");
ok(v.body?.ok === true, `ledger chain intact (${v.body?.length} entries)`);
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
