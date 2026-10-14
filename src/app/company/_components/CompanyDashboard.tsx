"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { CompanyResponse } from "@/app/api/v1/company/route";
import type { OperatorAction, RejectedAction } from "@/lib/operator/decide";
import type { CompanySnapshot } from "@/lib/operator/state";
import type { DecisionLogEntry } from "@/lib/types";
import { HttpError, addressUrl, apiFetch, fmtRelative, fmtTime, short } from "@/components/api";
import styles from "./CompanyDashboard.module.css";

const REFRESH_MS = 30_000;

interface OperatorPayload {
  type: "OPERATOR";
  rationale: string;
  candidates: OperatorAction[];
  rejected: RejectedAction[];
  chosen: { id: string; type: OperatorAction["type"]; params: OperatorAction["params"]; ok: boolean; result: unknown; error: string | null }[];
  nextCheckAt: number;
  nextCheckInSeconds: number;
  meta: { model: string; fallback: boolean; latencyMs: number; error?: string; guardNotes: string[] };
  at: number;
}
const asOperator = (e: DecisionLogEntry): OperatorPayload | null => {
  const p = e.payload as Partial<OperatorPayload> | null;
  return p && p.type === "OPERATOR" ? (p as OperatorPayload) : null;
};

function usdc(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: dp });
}
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
function errMsg(e: unknown): string {
  return e instanceof HttpError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
}
const ACTION_LABEL: Record<string, string> = {
  SWEEP_TO_YIELD: "Park in yield", REDEEM_FROM_YIELD: "Redeem from yield",
  SWEEP_TO_USYC: "Park in USYC", REDEEM_FROM_USYC: "Redeem from USYC", // legacy ledger entries
  RUN_PAYOUTS: "Run payouts", ADJUST_PRICE: "Adjust price", HOLD: "Hold",
};

function ModeBadge({ label, live, title }: { label: string; live: boolean; title?: string }) {
  return (
    <span className={`${styles.mode} ${live ? styles.modeLive : styles.modeDry}`} title={title}>
      <span className={styles.dot} aria-hidden="true" />{label} · {live ? "LIVE" : "DRY-RUN"}
    </span>
  );
}

export function CompanyDashboard() {
  const [data, setData] = useState<CompanyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(
    () => apiFetch<CompanyResponse>("/api/v1/company")
      .then((d) => { setData(d); setError(null); setUpdatedAt(Date.now()); })
      .catch((e: unknown) => setError(errMsg(e))),
    [],
  );
  useEffect(() => {
    void load();
    const id = setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const s = data?.snapshot ?? null;
  const latest = data?.decisions?.[0] ?? null;
  const latestOp = latest ? asOperator(latest) : null;
  const explorer = s?.mode?.explorerUrl ?? "";

  return (
    <div className="container">
      <div className={styles.head}>
        <div>
          <p className="kicker">company · operator · Arc 5042</p>
          <h1>CompliR is run by an agent. Here is its company.</h1>
          <p className="muted">
            It earns (x402), holds (Circle wallets, Circle Earn vaults), pays (contributors via GuardedTreasury), screens (its own product) and accounts (a signed ledger).
            Every tick below is one hash-chained decision you can replay.
          </p>
        </div>
        {s?.mode && (
          <div className={styles.modes}>
            <ModeBadge label="Treasury" live={s.mode.treasury === "live"} title="GuardedTreasury payouts" />
            <ModeBadge label="Yield" live={s.mode.yield === "live"} title={s.mode.yieldBackend === "usyc" ? "USYC sweep via the Teller" : "Revenue sweep into a Circle Earn (Morpho) USDC vault"} />
            <ModeBadge label="Circle" live={s.mode.circle === "live"} title="Circle Developer-Controlled Wallets" />
            <ModeBadge label="x402" live={s.mode.x402 === "enabled"} title="x402 payments on /v1/screen and /v1/watch" />
          </div>
        )}
      </div>

      {error && <div className="alert alertError" role="alert">Could not load the company: {error}</div>}
      {s && Object.keys(s.errors).length > 0 && (
        <div className={`alert alertInfo ${styles.degraded}`}>
          <strong>Partial snapshot.</strong> {Object.entries(s.errors).map(([k, v]) => `${k}: ${v}`).join(" · ")}
        </div>
      )}

      <Strips s={s} />

      <section className={`card ${styles.reasoning}`}>
        <div className={styles.cardHead}>
          <h2>Today&apos;s reasoning</h2>
          {latest && <Link href={`/log/${latest.id}`} className="mono small">ledger #{latest.seq} · {short(latest.hash, 10, 6)} →</Link>}
        </div>
        {!data ? <span className="skeleton" style={{ width: "80%", height: "1.2em" }} /> : latestOp ? (
          <>
            <p className={styles.rationale}>{latestOp.rationale}</p>
            <ul className={styles.actions}>
              {latestOp.chosen.map((c) => (
                <li key={c.id} className={c.ok ? styles.actionOk : styles.actionFail}>
                  <span className={`badge ${c.type === "HOLD" ? "badgeNeutral" : c.ok ? "badgeLOW" : "badgeHIGH"}`}>{ACTION_LABEL[c.type] ?? c.type}</span>
                  <span className="small">{describeAction(c)}</span>
                </li>
              ))}
            </ul>
            <p className="muted small">
              Decided {fmtRelative(latestOp.at)} by {latestOp.meta.fallback ? "deterministic rules (model unavailable)" : latestOp.meta.model}
              {latestOp.meta.guardNotes?.length ? ` · guards: ${latestOp.meta.guardNotes.join("; ")}` : ""} · next check {fmtRelative(latestOp.nextCheckAt)}
              {latestOp.rejected?.length ? ` · ${latestOp.rejected.length} action(s) not allowed by guards` : ""}
            </p>
          </>
        ) : (
          <p className="muted">No operator decision yet. The first tick runs via <code>worker/operator.ts</code> or <code>POST /api/internal/operator</code> (CRON_SECRET).</p>
        )}
      </section>

      <div className={styles.grid3}>
        <ReservesCard s={s} explorer={explorer} />
        <ObligationsCard s={s} />
        <PricingCard s={s} />
      </div>

      <section className={`card ${styles.timeline}`}>
        <div className={styles.cardHead}>
          <h2>Decision timeline</h2>
          <Link href="/ledger" className="small">full ledger →</Link>
        </div>
        {!data ? <span className="skeleton" style={{ width: "60%" }} /> : data.decisions.length === 0 ? <p className="muted">Nothing yet.</p> : (
          <ol className={styles.tl}>
            {data.decisions.map((e) => {
              const p = asOperator(e);
              if (!p) return null;
              const acts = p.chosen.map((c) => `${ACTION_LABEL[c.type] ?? c.type}${c.ok ? "" : " (failed)"}`).join(", ") || "Hold";
              return (
                <li key={e.id} className={styles.tlItem}>
                  <div className={styles.tlMeta}>
                    <Link href={`/log/${e.id}`} className="mono small">#{e.seq}</Link>
                    <span className="muted small" title={fmtTime(e.createdAt)}>{fmtRelative(e.createdAt)}</span>
                    {e.anchorTx && <span className="badge badgeLOW" title={`anchored ${e.anchorTx}`}>anchored</span>}
                  </div>
                  <div><strong>{acts}</strong> <span className="muted small">· {p.meta.fallback ? "rules" : p.meta.model}</span></div>
                  <p className={`small ${styles.tlRationale}`}>{p.rationale}</p>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className={`card ${styles.how}`}>
        <h2>How this company works</h2>
        <ol className={styles.steps}>
          <li><strong>Earn via x402.</strong> Every <code>POST /v1/screen</code> and <code>/v1/watch</code> from an outside caller is paid in USDC on Arc through the Circle facilitator; a non-2xx is never charged. The operator sets the price inside hard bounds.</li>
          <li><strong>Hold in Circle wallets.</strong> Revenue lands in a Circle Developer-Controlled Wallet (the x402 <code>payTo</code>); a second Gas-Station-sponsored ops wallet relays registry writes. Each wallet carries an app-enforced spending policy.</li>
          <li><strong>Park in yield.</strong> Idle USDC above the float (obligations due within 48 h + a fixed cushion) is deposited into the best Circle Earn vault on Arc (Morpho USDC, ERC-4626) that Circle does not flag as illiquid and that could pay the position back twice over today; a shortfall is redeemed.</li>
          <li><strong>Pay via GuardedTreasury, guarded by its own oracle.</strong> Every contributor invoice is screened by CompliR; <code>GuardedTreasury.release</code> re-checks the on-chain attestation, so neither the operator nor the owner can pay a HIGH-tier address.</li>
          <li><strong>Sign everything.</strong> Each operator tick, payout, sweep and verdict is one entry in a hash-chained ledger, Merkle-anchored on Arc. The reasoning above is the company&apos;s minutes.</li>
        </ol>
        <p className="muted small">
          {updatedAt ? `Updated ${fmtRelative(updatedAt)}` : "Loading…"} · refreshes every 30 s · raw JSON: <a href="/api/v1/company" target="_blank" rel="noopener noreferrer" className="mono">/api/v1/company</a> · <Link href="/payouts">payouts</Link> · <Link href="/numbers">numbers</Link>
        </p>
      </section>
    </div>
  );
}

function describeAction(c: OperatorPayload["chosen"][number]): string {
  const r = (c.result ?? {}) as Record<string, unknown>;
  if (c.error) return c.error;
  switch ((c.type as string) === "SWEEP_TO_USYC" || (c.type as string) === "REDEEM_FROM_USYC" ? "SWEEP_TO_YIELD" : c.type) {
    case "RUN_PAYOUTS": return `${r.processed ?? 0} invoice(s): ${r.paid ?? 0} paid, ${r.limited ?? 0} limited, ${r.held ?? 0} held${r.failed ? `, ${r.failed} failed` : ""} (${r.mode ?? "dry-run"})`;
    case "SWEEP_TO_YIELD":
    case "REDEEM_FROM_YIELD": {
      const plan = r.plan as { action?: string; amount?: number; vault?: { name?: string } | null } | undefined;
      return `${plan?.action ?? "NONE"} ${plan?.amount ?? c.params.amountUsdc ?? 0} USDC${plan?.vault?.name ? ` · ${plan.vault.name}` : ""} · ${r.mode ?? "dry"}${r.executed ? " · executed" : " · simulated"}${r.skipped ? ` · ${r.skipped}` : ""}`;
    }
    case "ADJUST_PRICE": return `${c.params.key}: ${c.params.fromUsdc} → ${c.params.toUsdc} USDC`;
    default: return "nothing moved this tick";
  }
}

function Strips({ s }: { s: CompanySnapshot | null }) {
  const rev = s?.revenue, res = s?.reserves, ob = s?.obligations;
  const held = res && (res.floatUsdc != null || res.yieldUsdc != null) ? (res.floatUsdc ?? 0) + (res.yieldUsdc ?? 0) : null;
  const items = [
    { label: "Earned", value: rev ? `${usdc(rev.totalUsdc, 4)} USDC` : null, sub: rev ? `${rev.callsPaid} paid calls · ${rev.payers} payers · ${usdc(rev.last24hUsdc, 4)} last 24 h` : "" },
    { label: "Held", value: s ? (held == null ? "-" : `${usdc(held)} USDC`) : null, sub: res ? `${res.floatUsdc == null ? "float unknown" : `${usdc(res.floatUsdc)} float`} · ${res.yieldUsdc == null ? "yield unknown" : `${usdc(res.yieldUsdc)} in yield`}` : "" },
    { label: "Paid out", value: ob ? `${usdc(ob.paidUsdc)} USDC` : null, sub: ob ? `${ob.paidInvoices} invoice(s) · ${usdc(ob.spentTodayUsdc)} today` : "" },
    { label: "Refused", value: ob ? `${usdc(ob.heldUsdc)} USDC` : null, sub: ob ? `${ob.heldInvoices} invoice(s) held by the oracle${rev?.refunds ? ` · ${rev.refunds} refund(s)` : ""}` : "" },
  ];
  return (
    <div className={styles.strips} aria-live="polite">
      {items.map((it) => (
        <div key={it.label} className={`card ${styles.strip}`}>
          <span className={styles.stripLabel}>{it.label}</span>
          <span className={styles.stripValue}>{it.value === null ? <span className="skeleton" style={{ width: 90, height: "1.3em" }} /> : it.value}</span>
          <span className="muted small">{it.sub}</span>
        </div>
      ))}
    </div>
  );
}

function ReservesCard({ s, explorer }: { s: CompanySnapshot | null; explorer: string }) {
  const r = s?.reserves;
  return (
    <section className="card">
      <div className={styles.cardHead}><h2>Reserves</h2>{r && <span className={`badge ${r.yieldMode === "live" ? "badgeLOW" : "badgeNeutral"}`}>{r.yieldBackend === "usyc" ? "USYC" : "Earn"} {r.yieldMode === "live" ? "live" : "dry-run"}</span>}</div>
      {!s ? <span className="skeleton" /> : !r ? <p className="muted small">unavailable</p> : (
        <dl className={styles.kv}>
          <dt>Float (USDC)</dt><dd>{r.floatUsdc == null ? <span className="muted">unknown{r.error ? ` - ${r.error}` : ""}</span> : usdc(r.floatUsdc, 4)}</dd>
          <dt>In yield</dt>
          <dd>
            {r.yieldUsdc == null ? <span className="muted">unknown</span> : `${usdc(r.yieldUsdc, 4)} USDC`}
            {r.positions.length > 0 && (
              <ul className={styles.wallets}>
                {r.positions.map((p) => {
                  const v = r.vaults?.find((x) => x.address.toLowerCase() === p.vault.toLowerCase());
                  return (
                    <li key={p.vault} className="small">
                      <strong>{p.name}</strong> <a className="mono" href={addressUrl(explorer, p.vault) ?? "#"} target="_blank" rel="noopener noreferrer">{short(p.vault)}</a>
                      {` · ${usdc(p.shares, 6)} shares · ${usdc(p.assetsUsdc, 4)} USDC`}
                      {v && ` · ${pct(v.apy)} APY · ${usdc(v.availableUsdc, 0)} USDC liquid`}{v?.illiquid && <span className="badge badgeHIGH"> illiquid</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </dd>
          {r.yieldBackend === "earn" && (
            <>
              <dt>Target vault</dt>
              <dd>
                {r.preferredVault ? (
                  <>
                    <strong>{r.preferredVault.name}</strong>{" "}
                    <a className="mono" href={addressUrl(explorer, r.preferredVault.address) ?? "#"} target="_blank" rel="noopener noreferrer">{short(r.preferredVault.address)}</a>
                    <span className="small"> · {pct(r.preferredVault.apy)} APY · {usdc(r.preferredVault.availableUsdc, 0)} USDC liquid · TVL {usdc(r.preferredVault.tvlUsdc, 0)}</span>
                  </>
                ) : <span className="muted">{r.vaultsError ? `Earn API unavailable - ${r.vaultsError}` : r.vaults ? "no vault passes the rules" : "unknown"}</span>}
                {r.vaults && r.yieldPolicy && (
                  <div className="muted small">
                    Circle Earn lists {r.vaults.length} USDC vault(s) on Arc; {r.vaults.filter((v) => v.illiquid).length} flagged illiquid and refused · rules: not illiquid, no RED warning,
                    {r.yieldPolicy.requireSentinel ? " Circle Sentinel," : ""} TVL ≥ {usdc(r.yieldPolicy.minTvlUsdc, 0)}, liquidity ≥ {r.yieldPolicy.liquidityMultiple}× position, best APY
                  </div>
                )}
              </dd>
            </>
          )}
          <dt>Keep liquid</dt><dd>{usdc(r.yieldFloatUsdc)} cushion + obligations due 48 h · min sweep {usdc(r.yieldMinSweepUsdc)}{r.yieldMaxSweepUsdc ? ` · max ${usdc(r.yieldMaxSweepUsdc)}/sweep` : ""}</dd>
          <dt>Revenue wallet</dt><dd className="mono">{r.revenueWallet ? <a href={addressUrl(explorer, r.revenueWallet) ?? "#"} target="_blank" rel="noopener noreferrer">{short(r.revenueWallet)}</a> : <span className="muted">unset</span>}</dd>
          <dt>Circle wallets</dt>
          <dd>
            <span className={`badge ${r.circle.enabled ? "badgeLOW" : "badgeNeutral"}`}>{r.circle.enabled ? "live" : "dry-run"}</span>
            {!r.circle.enabled && r.circle.reason && <span className="muted small"> {r.circle.reason}</span>}
            <ul className={styles.wallets}>
              {r.circle.wallets.map((w) => (
                <li key={w.role}>
                  <strong>{w.role}</strong> <span className="mono small">{w.address ? short(w.address) : "not provisioned"}</span>{w.accountType && <span className="muted small"> · {w.accountType}</span>}
                  {w.policy && <span className="muted small"> · policy {w.policy.perTxUsdc}/tx, {w.policy.dailyUsdc}/day{w.policy.allowlist.length ? `, ${w.policy.allowlist.length} allowed target(s)` : ""}{w.policy.contractAllowlist?.length ? `, ${w.policy.contractAllowlist.length} allowed contract(s)` : ""}</span>}
                  {w.balances.length > 0 && <span className="small"> · {w.balances.map((b) => `${b.amount} ${b.symbol}`).join(", ")}</span>}
                </li>
              ))}
              {r.circle.wallets.length === 0 && <li className="muted small">no wallets stored (scripts/circle/setup.ts)</li>}
            </ul>
          </dd>
        </dl>
      )}
    </section>
  );
}

function ObligationsCard({ s }: { s: CompanySnapshot | null }) {
  const o = s?.obligations;
  return (
    <section className="card">
      <div className={styles.cardHead}><h2>Obligations</h2>{s?.mode && <span className={`badge ${s.mode.treasury === "live" ? "badgeLOW" : "badgeNeutral"}`}>treasury {s.mode.treasury}</span>}</div>
      {!s ? <span className="skeleton" /> : !o ? <p className="muted small">unavailable</p> : (
        <dl className={styles.kv}>
          <dt>Pending</dt><dd>{o.pendingInvoices} invoice(s) · {usdc(o.pendingUsdc)} USDC</dd>
          <dt>Payable today</dt><dd>{usdc(o.dueTodayUsdc)} USDC <span className="muted small">({usdc(o.dailyHeadroomUsdc)} daily headroom)</span></dd>
          <dt>Held</dt><dd>{o.heldInvoices} invoice(s) · {usdc(o.heldUsdc)} USDC <span className="muted small">refused by the oracle</span></dd>
          <dt>Paid</dt><dd>{o.paidInvoices} invoice(s) · {usdc(o.paidUsdc)} USDC</dd>
          {o.policy && <><dt>Policy</dt><dd className="small">max tier {o.policy.maxTier} · {o.policy.perPayoutCapUsdc}/payout · {o.policy.dailyCapUsdc}/day{o.policy.requireAttestationOnChain ? " · on-chain attestation required" : ""}</dd></>}
        </dl>
      )}
      <p className="small" style={{ marginTop: 10 }}><Link href="/payouts">Guarded Payouts →</Link></p>
    </section>
  );
}

function PricingCard({ s }: { s: CompanySnapshot | null }) {
  const p = s?.pricing;
  return (
    <section className="card">
      <div className={styles.cardHead}><h2>Pricing</h2>{s?.mode && <span className={`badge ${s.mode.x402 === "enabled" ? "badgeLOW" : "badgeNeutral"}`}>x402 {s.mode.x402}</span>}</div>
      {!s ? <span className="skeleton" /> : !p ? <p className="muted small">unavailable</p> : (
        <dl className={styles.kv}>
          <dt>screen</dt><dd><strong>{p.screenUsdc} USDC</strong> <span className="muted small">per call · bounds 0.005–0.05</span></dd>
          <dt>watch</dt><dd><strong>{p.watchUsdc} USDC</strong> <span className="muted small">per 30 days · bounds 0.02–0.2</span></dd>
          <dt>Last change</dt><dd className="small">{p.lastChangeAt ? `${fmtRelative(p.lastChangeAt)} - ${p.reason}` : p.reason}</dd>
          <dt>Rails</dt><dd className="muted small">≤ 20% per change · ≥ 6 h between changes · raise on demand, lower after 48 h without an outside paid call</dd>
        </dl>
      )}
      {s?.screening && <p className="muted small" style={{ marginTop: 10 }}>Screening 24 h: {s.screening.screenings24h} ({s.screening.high24h} HIGH, {s.screening.medium24h} MEDIUM) · {s.screening.watchesActive} active watches</p>}
    </section>
  );
}
