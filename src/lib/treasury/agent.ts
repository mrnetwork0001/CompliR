/**
 * Treasury agent: pays pending invoices on Arc, but every payout goes through CompliR.
 *
 *   invoice → screen(payee) → decidePayout(policy) → [LIVE] GuardedTreasuryV2.releaseWithProof(payee, amount, decisionHash) → ledger "PAYOUT"
 *
 * Proof-of-screening: the live executor names the verdict it pays against (`decisionHash`, the keccak256 of the
 * canonical decision JSON that the attester signed). The contract requires the registry's current record for the
 * payee to carry exactly that hash, so a payment can never be made under a verdict other than the one on-chain.
 *
 * Risk-aware routing (schedule.ts): a MEDIUM payee is paid in three tranches - 1/3 now, 1/3 once the counterparty
 * answers EDD and still re-screens ≤ MEDIUM, the rest after 7 quiet days. Each tick releases the tranches that are
 * due; a HIGH re-grade cancels the pending ones.
 *
 * Modes (env, see treasuryStatus()):
 *   dry-run (default)  - screens, decides, records; txHash = null ("simulated"). No key needed.
 *   live               - TREASURY_MODE=live + TREASURY_PRIVATE_KEY + GUARDED_TREASURY_ADDRESS + REGISTRY_ADDRESS.
 *                        The attestation is mirrored to the registry first (awaited, then confirmed by reading the
 *                        record back), then `releaseWithProof` is simulated and sent; nonces are serialised in-process;
 *                        the receipt is awaited (Arc finality is deterministic).
 */
import { createPublicClient, createWalletClient, http, parseUnits, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcChain, registryEnabled, writeAttestationToRegistry } from "../chain/registryWriter";
import { config } from "../config";
import { getEddRequest } from "../edd";
import { guardedTreasuryV2Abi, registryAbi } from "../contracts";
import { appendDecision } from "../ledger";
import { screen } from "../pipeline";
import { TIER_ONCHAIN, type Address, type Tier, type Verdict } from "../types";
import {
  addSpend, cancelPendingTranches, finalizeScheduledInvoice, insertTranches, listTranches, markTrancheReleased, migrateTreasury, noteTranche, payeeBook,
  pendingInvoices, scheduledInvoices, seedDemoInvoices, settleInvoice, spentToday, updateScheduledInvoice, type Invoice, type InvoiceStatus, type TrancheRow,
} from "./invoices";
import { decidePayout, policyFromEnv, round6, type OnChainAttestation, type PayoutDecision, type TreasuryPolicy } from "./policy";
import { planSchedule, tierWithin, type DueCondition, type Schedule } from "./schedule";

export type TreasuryMode = "dry-run" | "live";
export const TREASURY_CLIENT_ID = "treasury-agent";

export interface TreasuryStatus {
  mode: TreasuryMode;
  chainId: number;
  explorerUrl: string;
  treasuryAddress: Address | null;
  agentAddress: Address | null;
  registryAddress: Address | null;
  usdcAddress: Address;
  policy: TreasuryPolicy;
  /** what is still missing before TREASURY_MODE=live takes effect */
  missingForLive: string[];
}

function liveEnv() {
  const e = process.env;
  const missing: string[] = [];
  if ((e.TREASURY_MODE ?? "").toLowerCase() !== "live") missing.push("TREASURY_MODE=live");
  if (!/^0x[0-9a-fA-F]{64}$/.test(e.TREASURY_PRIVATE_KEY ?? "")) missing.push("TREASURY_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{40}$/.test(e.GUARDED_TREASURY_ADDRESS ?? "")) missing.push("GUARDED_TREASURY_ADDRESS");
  if (!/^0x[0-9a-fA-F]{40}$/.test(e.REGISTRY_ADDRESS ?? "")) missing.push("REGISTRY_ADDRESS");
  return { missing, key: e.TREASURY_PRIVATE_KEY as `0x${string}` | undefined, treasury: e.GUARDED_TREASURY_ADDRESS?.toLowerCase() as Address | undefined };
}

export function treasuryMode(): TreasuryMode {
  return liveEnv().missing.length === 0 ? "live" : "dry-run";
}

export function treasuryStatus(): TreasuryStatus {
  const c = config();
  const le = liveEnv();
  const mode: TreasuryMode = le.missing.length === 0 ? "live" : "dry-run";
  let agent: Address | null = null;
  if (le.key && /^0x[0-9a-fA-F]{64}$/.test(le.key)) {
    try { agent = privateKeyToAccount(le.key).address.toLowerCase() as Address; } catch { agent = null; }
  }
  return {
    mode, chainId: c.ARC_CHAIN_ID, explorerUrl: c.ARC_EXPLORER_URL,
    treasuryAddress: le.treasury ?? null, agentAddress: agent,
    registryAddress: (c.REGISTRY_ADDRESS?.toLowerCase() as Address | undefined) ?? null, usdcAddress: c.USDC_ADDRESS.toLowerCase() as Address,
    policy: policyFromEnv(process.env, mode === "live"), missingForLive: le.missing,
  };
}

/** Migrate + seed the demo invoices (idempotent). Called by the routes and the tick. */
export async function ensureTreasury(): Promise<void> {
  await migrateTreasury();
  await seedDemoInvoices();
}

/** The proof a payment is made against: keccak256 of the verdict's canonical decision JSON (what the attester signed). */
export function verdictDecisionHash(v: Verdict): `0x${string}` {
  return v.attestation.typedData.message.decisionHash;
}

// ── on-chain helpers (live mode only) ────────────────────────────────────────
function clients(key: `0x${string}`) {
  const c = config();
  const account = privateKeyToAccount(key);
  const chain = arcChain();
  return {
    account,
    wallet: createWalletClient({ account, chain, transport: http(c.ARC_RPC_URL) }),
    pub: createPublicClient({ chain, transport: http(c.ARC_RPC_URL) }),
  };
}

export async function readRegistryAttestation(payee: Address): Promise<OnChainAttestation | null> {
  const c = config();
  if (!c.REGISTRY_ADDRESS) return null;
  const pub = createPublicClient({ chain: arcChain(), transport: http(c.ARC_RPC_URL, { timeout: 8_000 }) });
  const [tier, validUntil] = await pub.readContract({ address: c.REGISTRY_ADDRESS as Address, abi: registryAbi as unknown as Abi, functionName: "tierOf", args: [payee] }) as readonly [number, bigint, `0x${string}`];
  return { tier: Number(tier), validUntil: Number(validUntil) };
}

/** `recordOf(payee).decisionHash` on the registry - what `releaseWithProof` compares against. */
export async function readRegistryDecisionHash(payee: Address): Promise<`0x${string}` | null> {
  const c = config();
  if (!c.REGISTRY_ADDRESS) return null;
  const pub = createPublicClient({ chain: arcChain(), transport: http(c.ARC_RPC_URL, { timeout: 8_000 }) });
  const r = await pub.readContract({ address: c.REGISTRY_ADDRESS as Address, abi: registryAbi as unknown as Abi, functionName: "recordOf", args: [payee] }) as { decisionHash: `0x${string}` };
  return r.decisionHash;
}

/**
 * Live only: mirror the verdict to the registry (awaited) and read the record back. The contract reads the
 * registry, not our DB, so the release must not start before the record carries this verdict's decisionHash.
 */
async function mirrorVerdictOnChain(verdict: Verdict, payee: Address, opts: { confirmMs?: number } = {}): Promise<OnChainAttestation | null> {
  if (registryEnabled()) {
    try { const tx = await writeAttestationToRegistry(verdict); if (tx) verdict.attestation.registryTx = tx; }
    catch (e) { console.warn("[treasury] registry write failed:", (e as Error)?.message); }
  }
  const want = verdictDecisionHash(verdict);
  const deadline = Date.now() + (opts.confirmMs ?? 45_000);
  // the public Arc RPC rate-limits bursts (HTTP 429): reads are retried with backoff until the deadline, never treated as "no record" early
  let wait = 1_500;
  for (;;) {
    try { if ((await readRegistryDecisionHash(payee)) === want) break; }
    catch (e) { console.warn("[treasury] registry read failed (retrying):", (e as Error)?.message); }
    if (Date.now() >= deadline) { console.warn("[treasury] registry record does not carry decisionHash", want, "yet - releaseWithProof will revert if it still differs"); break; }
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 2, 8_000);
  }
  for (let attempt = 1; ; attempt++) {
    try { return await readRegistryAttestation(payee); }
    catch (e) {
      console.warn("[treasury] registry read failed:", (e as Error)?.message);
      if (attempt >= 4) return null;
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
}

export interface ExecutorContext {
  invoice: Invoice;
  verdict: Verdict;
  decision: PayoutDecision;
  /** set when the release is one tranche of a schedule */
  tranche?: number;
}
export interface Executor {
  (payee: Address, amountUsdc: number, ctx: ExecutorContext): Promise<`0x${string}` | null>;
}

let lastTx: Promise<unknown> = Promise.resolve(); // serialise nonces (one treasury key per process)
/**
 * LIVE executor: `releaseWithProof(payee, amount, decisionHash)` on GuardedTreasuryV2. Simulated first (surfaces
 * "CompliR: payee tier too high" / "CompliR: decisionHash mismatch" without gas), then sent; the receipt is awaited.
 */
export const liveExecutor: Executor = (payee, amountUsdc, ctx) => {
  const le = liveEnv();
  if (le.missing.length || !le.key || !le.treasury) throw new Error(`treasury not live: missing ${le.missing.join(", ")}`);
  const { account, wallet, pub } = clients(le.key);
  const amount6 = parseUnits(amountUsdc.toFixed(6), 6);
  const decisionHash = verdictDecisionHash(ctx.verdict);
  const run = async () => {
    const { request } = await pub.simulateContract({ account, address: le.treasury!, abi: guardedTreasuryV2Abi, functionName: "releaseWithProof", args: [payee, amount6, decisionHash] });
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== "success") throw new Error(`releaseWithProof reverted on-chain (tx ${hash})`);
    return hash;
  };
  const p = lastTx.then(run, run);
  lastTx = p.catch(() => undefined);
  return p;
};
/** DRY-RUN executor: nothing leaves the process; txHash is null ("simulated"). */
export const dryRunExecutor: Executor = async () => null;

// ── the tick ─────────────────────────────────────────────────────────────────
export interface PayoutResult {
  invoiceId: string;
  label: string;
  payee: Address;
  status: InvoiceStatus;
  action: PayoutDecision["action"] | null;
  tier: Tier | null;
  score: number | null;
  amountUsdc: number;
  paidUsdc: number;
  heldUsdc: number;
  txHash: `0x${string}` | null;
  decisionId: string | null;
  decisionHash: `0x${string}` | null;
  payoutDecisionId: string | null;
  reason: string;
  /** schedule progress (MEDIUM payees): tranches released / planned */
  schedule?: { released: number; total: number; cancelled: number } | null;
}
export interface TrancheResult {
  invoiceId: string;
  label: string;
  payee: Address;
  n: number;
  amountUsdc: number;
  status: "RELEASED" | "CANCELLED" | "PENDING";
  txHash: `0x${string}` | null;
  decisionId: string | null;
  note: string;
}
export interface TickResult {
  mode: TreasuryMode;
  processed: number;
  paid: number;
  limited: number;
  scheduled: number;
  held: number;
  failed: number;
  results: PayoutResult[];
  /** tranche releases / cancellations of already SCHEDULED invoices during this tick */
  tranches: TrancheResult[];
}
export interface TickOptions {
  /** injected for tests */
  screenFn?: typeof screen;
  executor?: Executor;
  policy?: TreasuryPolicy;
  now?: number;
  /** skip the demo seed (tests) */
  seed?: boolean;
}

export async function runTreasuryOnce(opts: TickOptions = {}): Promise<TickResult> {
  const cfg = config();
  const mode = treasuryMode();
  const result: TickResult = { mode, processed: 0, paid: 0, limited: 0, scheduled: 0, held: 0, failed: 0, results: [], tranches: [] };
  if (cfg.COMPLIR_PAUSED) return result;
  if (opts.seed === false) await migrateTreasury(); else await ensureTreasury();

  const policy = opts.policy ?? policyFromEnv(process.env, mode === "live");
  const doScreen = opts.screenFn ?? screen;
  const execute = opts.executor ?? (mode === "live" ? liveExecutor : dryRunExecutor);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const treasuryAddr = treasuryStatus().treasuryAddress;
  const ctx: TickContext = { mode, policy, doScreen, execute, now, treasuryAddr, spent: await spentToday(now) };

  const pending = await pendingInvoices();
  for (const inv of pending) {
    result.processed++;
    const r = await processPendingInvoice(inv, ctx);
    if (r.status === "PAID") result.paid++; else if (r.status === "LIMITED") result.limited++; else if (r.status === "SCHEDULED") result.scheduled++; else if (r.status === "HELD") result.held++; else result.failed++;
    result.results.push(r);
  }

  // due tranches of invoices scheduled on earlier ticks
  for (const inv of await scheduledInvoices()) {
    result.tranches.push(...await releaseDueTranches(inv, ctx));
  }
  return result;
}

interface TickContext {
  mode: TreasuryMode;
  policy: TreasuryPolicy;
  doScreen: typeof screen;
  execute: Executor;
  now: number;
  treasuryAddr: Address | null;
  spent: number;
}

function verdictSummary(verdict: Verdict | null) {
  return verdict ? {
    decisionId: verdict.decisionId, decisionHash: verdictDecisionHash(verdict), tier: verdict.tier, score: verdict.score, rationale: verdict.rationale,
    recommendedLimits: verdict.recommendedLimits, reasonCodes: verdict.reasons.map((r) => r.code), screenedAt: verdict.screenedAt,
    attestation: { signature: verdict.attestation.signature, attester: verdict.attestation.attester, validUntil: verdict.attestation.validUntil, registryTx: verdict.attestation.registryTx },
  } : null;
}

async function processPendingInvoice(inv: Invoice, ctx: TickContext): Promise<PayoutResult> {
  const { mode, policy, doScreen, execute, now, treasuryAddr } = ctx;
  let verdict: Verdict | null = null;
  let decision: PayoutDecision | null = null;
  let schedule: Schedule | null = null;
  let txHash: `0x${string}` | null = null;
  let status: InvoiceStatus;
  let reason: string;
  let error: string | null = null;
  let paidUsdc = 0;
  try {
    // 1. screen the payee (CompliR verdict: deterministic score/tier + analyst rationale + signed attestation)
    //    payee book = trusted (previously paid) payees, so a new address that merely resembles one is flagged as a
    //    lookalike; a payee already in the book is judged on sanctions / blacklist / funder taint, not on resembling itself
    const book = await payeeBook(); // refreshed per invoice: a payee paid earlier in this tick is already trusted
    const known = book.some((p) => p.address === inv.payee);
    verdict = await doScreen({ address: inv.payee, amountUsdc: inv.amountUsdc, clientId: TREASURY_CLIENT_ID, payeeBook: known ? undefined : book }, { writeOnChain: false });

    // 2. live: mirror the attestation on-chain first (GuardedTreasury reads the registry, not our DB)
    const onChain = mode === "live" ? await mirrorVerdictOnChain(verdict, inv.payee) : null;

    // 3. policy
    decision = decidePayout({ amountUsdc: inv.amountUsdc }, verdict, policy, ctx.spent, { onChain, now });
    reason = decision.reason;

    if (decision.action === "HOLD" || decision.amount <= 0) {
      status = "HELD";
    } else {
      // 4. MEDIUM → schedule (1/3 now, 1/3 after EDD, rest after 7 quiet days); LOW → pay / limit as decided
      schedule = planSchedule({ amountUsdc: inv.amountUsdc }, { ...verdict, screenedAt: verdict.screenedAt }, policy, { now });
      const first = schedule?.tranches[0];
      const amount = first ? round6(Math.min(first.amountUsdc, decision.amount)) : decision.amount;
      txHash = await execute(inv.payee, amount, { invoice: inv, verdict, decision, tranche: first ? 1 : undefined });
      ctx.spent = round6(ctx.spent + amount);
      await addSpend(amount, now);
      paidUsdc = amount;
      if (schedule && first) {
        status = "SCHEDULED";
        await insertTranches(inv.id, schedule.tranches.map((t) => ({ n: t.n, amountUsdc: t.amountUsdc, dueCondition: t.dueCondition })), now);
        await markTrancheReleased(inv.id, 1, { txHash, decisionId: verdict.decisionId, decisionHash: verdictDecisionHash(verdict), note: "released with the invoice" }, now);
        const rest = schedule.tranches.slice(1).map((t) => `tranche ${t.n} ${t.amountUsdc} USDC ${t.label}`).join("; ");
        reason = `SCHEDULED: ${amount} USDC released now (tranche 1 of ${schedule.tranches.length}); ${rest}${schedule.unscheduledUsdc > 0 ? `; ${schedule.unscheduledUsdc} USDC above 3× the ${schedule.limitUsdc} USDC limit stays held` : ""}. ${verdict.tier} (score ${verdict.score}). ${verdict.rationale}`.trim();
      } else {
        status = decision.action === "PAY" ? "PAID" : "LIMITED";
      }
    }
  } catch (e) {
    error = (e as Error)?.message ?? String(e);
    status = "FAILED";
    reason = `FAILED: ${error}${decision ? ` - intended ${decision.action} ${decision.amount} USDC. ${decision.reason}` : ""}`;
    console.warn("[treasury] invoice", inv.id, "failed:", error);
  }

  // 5. ledger: every decision, including HOLD and FAILED, with the verdict's decisionId + the signed attestation
  const heldUsdc = round6(inv.amountUsdc - paidUsdc);
  const action = status === "FAILED" ? null : decision?.action ?? "HOLD";
  const payload = {
    type: "PAYOUT", invoiceId: inv.id, label: inv.label, payee: inv.payee, memo: inv.memo, amountUsdc: inv.amountUsdc,
    action, status, paidUsdc, heldUsdc, bound: decision?.bound ?? null, reason,
    mode, simulated: mode !== "live", txHash, treasury: treasuryAddr, policy, error,
    release: txHash ? { function: "releaseWithProof", decisionHash: verdict ? verdictDecisionHash(verdict) : null } : null,
    schedule: schedule ? { tranche: 1, of: schedule.tranches.length, limitUsdc: schedule.limitUsdc, tranches: schedule.tranches.map((t) => ({ n: t.n, amountUsdc: t.amountUsdc, dueCondition: t.dueCondition })), unscheduledUsdc: schedule.unscheduledUsdc } : null,
    verdict: verdictSummary(verdict),
    decidedAt: now,
  };
  const entry = await appendDecision({ kind: "PAYOUT", subject: inv.payee, clientId: TREASURY_CLIENT_ID, payload });

  await settleInvoice(inv.id, {
    status, decisionId: verdict?.decisionId ?? null, payoutDecisionId: entry.id, decisionHash: verdict ? verdictDecisionHash(verdict) : null, txHash, paidUsdc, heldUsdc,
    action, tier: verdict?.tier ?? null, score: verdict?.score ?? null, reason, mode,
  });

  return {
    invoiceId: inv.id, label: inv.label, payee: inv.payee, status, action,
    tier: verdict?.tier ?? null, score: verdict?.score ?? null, amountUsdc: inv.amountUsdc, paidUsdc, heldUsdc, txHash,
    decisionId: verdict?.decisionId ?? null, decisionHash: verdict ? verdictDecisionHash(verdict) : null, payoutDecisionId: entry.id, reason,
    schedule: schedule ? { released: status === "SCHEDULED" ? 1 : 0, total: schedule.tranches.length, cancelled: 0 } : null,
  };
}

/** Is the tranche's condition met right now? `needsRescreen` = the payee must still grade ≤ maxTier before paying. */
async function evaluateCondition(c: DueCondition, now: number): Promise<{ due: boolean; needsRescreen: boolean; maxTier: Tier; note: string }> {
  switch (c.kind) {
    case "now": return { due: true, needsRescreen: false, maxTier: "MEDIUM", note: "due now" };
    case "edd_answered": {
      const edd = await getEddRequest(c.eddId);
      if (!edd) return { due: false, needsRescreen: true, maxTier: c.maxTier, note: `EDD ${c.eddId} not found` };
      if (edd.status === "OPEN") return { due: false, needsRescreen: true, maxTier: c.maxTier, note: `waiting for the counterparty to answer EDD ${c.eddId}` };
      return { due: true, needsRescreen: true, maxTier: c.maxTier, note: `EDD ${c.eddId} ${edd.status.toLowerCase()}${edd.answeredAt ? ` at ${new Date(edd.answeredAt * 1000).toISOString()}` : ""}` };
    }
    case "quiet_period": {
      if (now < c.until) return { due: false, needsRescreen: true, maxTier: c.maxTier, note: `quiet period until ${new Date(c.until * 1000).toISOString()}` };
      return { due: true, needsRescreen: true, maxTier: c.maxTier, note: `quiet period ended ${new Date(c.until * 1000).toISOString()}` };
    }
  }
}

/** Release every due tranche of a SCHEDULED invoice (one re-screen per invoice per tick); HIGH cancels the rest. */
async function releaseDueTranches(inv: Invoice, ctx: TickContext): Promise<TrancheResult[]> {
  const { mode, policy, doScreen, execute, now, treasuryAddr } = ctx;
  const out: TrancheResult[] = [];
  const tranches = (await listTranches(inv.id)) as TrancheRow<DueCondition>[];
  const pendingT = tranches.filter((t) => t.status === "PENDING");
  if (!pendingT.length) { await finalize(inv, tranches); return out; }

  let verdict: Verdict | null = null;
  let onChain: OnChainAttestation | null = null;
  const base = (t: TrancheRow<DueCondition>): Omit<TrancheResult, "status" | "txHash" | "decisionId" | "note"> => ({ invoiceId: inv.id, label: inv.label, payee: inv.payee, n: t.n, amountUsdc: t.amountUsdc });

  for (const t of pendingT) {
    const cond = await evaluateCondition(t.dueCondition, now);
    if (!cond.due) { await noteTranche(inv.id, t.n, cond.note); out.push({ ...base(t), status: "PENDING", txHash: null, decisionId: null, note: cond.note }); continue; }

    try {
      // re-screen once per invoice per tick (RESCREEN entry on the ledger; payee is in the book → no lookalike check against itself)
      if (!verdict) {
        verdict = await doScreen({ address: inv.payee, amountUsdc: inv.amountUsdc, clientId: TREASURY_CLIENT_ID }, { kind: "RESCREEN", writeOnChain: false });
        if (!tierWithin(verdict.tier, cond.maxTier) || !tierWithin(verdict.tier, policy.maxTier)) {
          // HIGH re-grade: cancel everything still pending, record it, stop
          const note = `cancelled: payee re-screened ${verdict.tier} (score ${verdict.score}) on ${verdict.decisionId}. ${verdict.rationale}`.trim();
          const n = await cancelPendingTranches(inv.id, note, verdict.decisionId);
          const entry = await appendDecision({ kind: "PAYOUT", subject: inv.payee, clientId: TREASURY_CLIENT_ID, payload: {
            type: "PAYOUT", invoiceId: inv.id, label: inv.label, payee: inv.payee, amountUsdc: inv.amountUsdc, action: "HOLD", status: "SCHEDULED",
            tranchesCancelled: n, paidUsdc: inv.paidUsdc, heldUsdc: inv.heldUsdc, reason: note, mode, simulated: mode !== "live", txHash: null, treasury: treasuryAddr, policy,
            verdict: verdictSummary(verdict), decidedAt: now,
          } });
          await updateScheduledInvoice(inv.id, { paidUsdc: inv.paidUsdc, heldUsdc: inv.heldUsdc, txHash: null, reason: `SCHEDULE CANCELLED after ${inv.paidUsdc} USDC: ${note}`, payoutDecisionId: entry.id });
          for (const p of pendingT) out.push({ ...base(p), status: "CANCELLED", txHash: null, decisionId: verdict.decisionId, note });
          await finalize(inv, await listTranches(inv.id));
          return out;
        }
        onChain = mode === "live" ? await mirrorVerdictOnChain(verdict, inv.payee) : null;
      }
      const v = verdict!;
      // caps + headroom + registry check apply to the tranche like to any payout; a bound tranche simply waits
      const decision = decidePayout({ amountUsdc: t.amountUsdc }, v, policy, ctx.spent, { onChain, now });
      if (decision.action !== "PAY") {
        const note = `${cond.note}; waiting: ${decision.reason}`;
        await noteTranche(inv.id, t.n, note);
        out.push({ ...base(t), status: "PENDING", txHash: null, decisionId: v.decisionId, note });
        continue;
      }
      const txHash = await execute(inv.payee, t.amountUsdc, { invoice: inv, verdict: v, decision, tranche: t.n });
      ctx.spent = round6(ctx.spent + t.amountUsdc);
      await addSpend(t.amountUsdc, now);
      const paidUsdc = round6(inv.paidUsdc + t.amountUsdc);
      const heldUsdc = round6(inv.amountUsdc - paidUsdc);
      const note = `released: ${cond.note}; re-screen ${v.tier} (score ${v.score})`;
      await markTrancheReleased(inv.id, t.n, { txHash, decisionId: v.decisionId, decisionHash: verdictDecisionHash(v), note }, now);
      const entry = await appendDecision({ kind: "PAYOUT", subject: inv.payee, clientId: TREASURY_CLIENT_ID, payload: {
        type: "PAYOUT", invoiceId: inv.id, label: inv.label, payee: inv.payee, amountUsdc: inv.amountUsdc, action: "PAY", status: "SCHEDULED",
        tranche: t.n, trancheAmountUsdc: t.amountUsdc, dueCondition: t.dueCondition, paidUsdc, heldUsdc, reason: note, mode, simulated: mode !== "live", txHash, treasury: treasuryAddr, policy,
        release: txHash ? { function: "releaseWithProof", decisionHash: verdictDecisionHash(v) } : null, verdict: verdictSummary(v), decidedAt: now,
      } });
      const released = tranches.filter((x) => x.status === "RELEASED").length + out.filter((x) => x.status === "RELEASED").length + 1;
      await updateScheduledInvoice(inv.id, { paidUsdc, heldUsdc, txHash, reason: `SCHEDULED: ${released}/${tranches.length} tranches released (${paidUsdc} USDC); tranche ${t.n} ${note}`, payoutDecisionId: entry.id });
      inv = { ...inv, paidUsdc, heldUsdc };
      out.push({ ...base(t), status: "RELEASED", txHash, decisionId: v.decisionId, note });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      console.warn("[treasury] tranche", inv.id, t.n, "failed:", msg);
      await noteTranche(inv.id, t.n, `failed: ${msg}`);
      out.push({ ...base(t), status: "PENDING", txHash: null, decisionId: verdict?.decisionId ?? null, note: `failed: ${msg}` });
    }
  }
  await finalize(inv, await listTranches(inv.id));
  return out;
}

/** once no tranche is PENDING the invoice leaves SCHEDULED: PAID when everything was released in full, else LIMITED */
async function finalize(inv: Invoice, tranches: TrancheRow[]): Promise<void> {
  if (tranches.some((t) => t.status === "PENDING")) return;
  const released = round6(tranches.filter((t) => t.status === "RELEASED").reduce((s, t) => s + t.amountUsdc, 0));
  await finalizeScheduledInvoice(inv.id, released >= round6(inv.amountUsdc) ? "PAID" : "LIMITED");
}

/** numeric on-chain tier for the policy's maxTier (what `release` passes to `isAllowed`) */
export function policyMaxTierOnChain(policy: TreasuryPolicy): number {
  return TIER_ONCHAIN[policy.maxTier];
}
