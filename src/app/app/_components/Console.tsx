"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { maskAddress } from "@/app/api/_lib/public-types";
import type { OperatorAction } from "@/lib/operator/decide";
import type { DecisionLogEntry, Tier } from "@/lib/types";
import { CopyButton } from "@/components/CopyButton";
import { fmtRelative, fmtTime, short } from "@/components/api";
import { Icon, type IconName } from "./icons";
import { CONSOLE_REFRESH_MS, useConsoleData, useNow, useTicker, type ConsoleData } from "./useConsoleData";
import styles from "./Console.module.css";

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

interface OperatorPayload {
  type: "OPERATOR";
  rationale: string;
  chosen: { id: string; type: OperatorAction["type"]; ok: boolean; error: string | null }[];
  rejected?: unknown[];
  nextCheckAt: number;
  nextCheckInSeconds: number;
  meta: { model: string; fallback: boolean; guardNotes?: string[] };
  at: number;
}
const asOperator = (e: DecisionLogEntry | null | undefined): OperatorPayload | null => {
  const p = e?.payload as Partial<OperatorPayload> | null | undefined;
  return p && p.type === "OPERATOR" ? (p as OperatorPayload) : null;
};
const ACTION_LABEL: Record<OperatorAction["type"], string> = {
  SWEEP_TO_USYC: "Park in USYC",
  REDEEM_FROM_USYC: "Redeem from USYC",
  RUN_PAYOUTS: "Run payouts",
  ADJUST_PRICE: "Adjust price",
  HOLD: "Hold",
};

/** seconds-or-ms unix → ms */
const ms = (t: number) => (t < 1e12 ? t * 1000 : t);

function usdc(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: dp });
}
const int = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());

function tierOf(e: DecisionLogEntry): Tier | null {
  const p = e.payload as { tier?: unknown; verdict?: { tier?: unknown }; to?: unknown } | null;
  const t = p?.tier ?? p?.verdict?.tier ?? p?.to;
  return t === "LOW" || t === "MEDIUM" || t === "HIGH" ? t : null;
}

const SOLIDITY = "require(ICompliR(registry).isAllowed(payee, ICompliR.Tier.MEDIUM));";

/* ─── Small presentational pieces ─────────────────────────────────────────── */

function Sk({ w = 80 }: { w?: number | string }) {
  return <span className="skeleton" style={{ width: w, height: "1em", display: "inline-block", verticalAlign: "middle" }} />;
}

function Pill({ state, children, title }: { state: "ok" | "warn" | "bad" | "off" | "unknown"; children: ReactNode; title?: string }) {
  return (
    <span className={styles.pill} data-state={state} title={title}>
      <span className={styles.pillDot} aria-hidden="true" />
      {children}
    </span>
  );
}

function Kpi({ label, value, unit, sub, aside }: { label: string; value: ReactNode | null; unit?: string; sub: ReactNode | null; aside?: ReactNode }) {
  return (
    <div className={styles.kpi}>
      <span className={styles.kpiLabel}>{label}</span>
      <span className={styles.kpiValue}>
        {value === null ? <Sk w={72} /> : value}
        {unit && value !== null && <span className={styles.kpiUnit}>{unit}</span>}
        {aside}
      </span>
      <span className={styles.kpiSub}>{sub === null ? <Sk w={120} /> : sub}</span>
    </div>
  );
}

interface CardSpec {
  href: string;
  icon: IconName;
  title: string;
  body: string;
  /** null = loading */
  stat: ReactNode | null;
  external?: boolean;
}

function SurfaceCard({ c }: { c: CardSpec }) {
  const inner = (
    <>
      <span className={styles.gIcon}>
        <Icon name={c.icon} />
      </span>
      <span className={styles.gText}>
        <span className={styles.gTitle}>{c.title}</span>
        <span className={styles.gBody}>{c.body}</span>
        <span className={`${styles.gStat} mono`}>{c.stat === null ? <Sk w={110} /> : c.stat}</span>
      </span>
      <span className={styles.gArrow}>
        <Icon name="arrow" size={16} />
      </span>
    </>
  );
  return c.external ? (
    <a href={c.href} className={styles.gCard} target="_blank" rel="noopener noreferrer">
      {inner}
    </a>
  ) : (
    <Link href={c.href} className={styles.gCard}>
      {inner}
    </Link>
  );
}

function Group({ id, label, blurb, cards }: { id: string; label: string; blurb: string; cards: CardSpec[] }) {
  return (
    <section className={styles.group} aria-labelledby={`g-${id}`}>
      <header className={styles.groupHead}>
        <h2 id={`g-${id}`} className={styles.groupTitle}>
          {label}
        </h2>
        <p className={styles.groupBlurb}>{blurb}</p>
      </header>
      <div className={styles.groupGrid} data-count={cards.length}>
        {cards.map((c) => (
          <SurfaceCard key={c.href} c={c} />
        ))}
      </div>
    </section>
  );
}

/* ─── Sections ────────────────────────────────────────────────────────────── */

function StatusBar({ d, now }: { d: ConsoleData; now: number }) {
  const h = d.health;
  const mode = d.company?.snapshot.mode ?? null;
  const latest = d.company?.decisions?.[0] ?? null;
  const op = asOperator(latest);

  const signer = mode?.signer ?? h?.signer?.mode ?? null;
  const x402on = h ? !h.x402.disabled : mode ? mode.x402 === "enabled" : null;
  const paused = h ? h.paused : mode ? mode.paused : null;
  const chain = h?.chainId ?? mode?.chainId ?? null;

  // Heartbeat: the operator's last tick vs. when it promised to check again.
  let beat: { state: "ok" | "warn" | "off" | "unknown"; text: ReactNode; title?: string };
  if (!d.ready) beat = { state: "unknown", text: <Sk w={140} /> };
  else if (!latest || !op) beat = { state: "off", text: "agent · no tick yet", title: "No operator decision in the ledger" };
  else {
    const tickedAt = ms(latest.createdAt);
    const next = ms(op.nextCheckAt);
    const late = now > next + 15 * 60_000;
    beat = {
      state: late ? "warn" : "ok",
      title: `Operator tick #${latest.seq} at ${fmtTime(latest.createdAt)} · next check ${fmtTime(op.nextCheckAt)}`,
      text: (
        <>
          agent ticked {fmtRelative(tickedAt)} · {late ? "check overdue" : `next ${fmtRelative(next)}`}
        </>
      ),
    };
  }

  return (
    <div className={styles.statusBar} role="status" aria-live="polite">
      <div className={styles.statusLeft}>
        <Pill state={h ? (h.ok ? "ok" : "bad") : d.ready ? "bad" : "unknown"} title={h?.error ?? undefined}>
          {chain ? `Arc · chain ${chain}` : d.ready ? "Arc · unreachable" : <Sk w={90} />}
        </Pill>
        <Pill state={signer ? (signer === "circle" ? "ok" : "off") : "unknown"} title={signer === "circle" ? "Circle Developer-Controlled Wallet signs registry writes" : "Local key signs registry writes"}>
          {signer ? `signer ${signer}` : <Sk w={80} />}
        </Pill>
        <Pill state={x402on == null ? "unknown" : x402on ? "ok" : "off"} title={h ? `${h.x402.priceScreenUsdc} USDC / screen · ${h.x402.priceWatchUsdc} USDC / watch` : undefined}>
          {x402on == null ? <Sk w={70} /> : x402on ? `x402 on · ${h?.x402.priceScreenUsdc ?? "—"} USDC/screen` : "x402 off · free calls"}
        </Pill>
        <Pill state={paused == null ? "unknown" : paused ? "warn" : "ok"}>{paused == null ? <Sk w={60} /> : paused ? "paused" : "running"}</Pill>
      </div>
      <span className={styles.heartbeat} data-state={beat.state} title={beat.title}>
        <span className={styles.beatDot} aria-hidden="true" />
        <span className="mono">{beat.text}</span>
      </span>
    </div>
  );
}

function Kpis({ d }: { d: ConsoleData }) {
  const s = d.company?.snapshot ?? null;
  const rev = s?.revenue ?? null;
  const ob = s?.obligations ?? null;
  const scr = s?.screening ?? null;
  const pt = d.payouts?.totals ?? null;
  const ready = d.ready;

  const earned = rev ? usdc(rev.totalUsdc, 4) : ready ? usdc(d.numbers?.totalPaidUsdc ?? 0, 4) : null;
  const earnedSub = rev ? `${usdc(rev.last24hUsdc, 4)} last 24 h · ${rev.callsPaid} paid call${rev.callsPaid === 1 ? "" : "s"} · ${rev.payers} payer${rev.payers === 1 ? "" : "s"}` : ready ? `${int(d.numbers?.outsidePayers ?? 0)} outside payers` : null;

  const paidUsdc = ob?.paidUsdc ?? pt?.paidUsdc ?? null;
  const heldUsdc = ob?.heldUsdc ?? pt?.heldUsdc ?? null;
  const payMode = s?.mode?.treasury ?? d.payouts?.mode ?? null;
  const paidValue = ready ? (
    <>
      {usdc(paidUsdc ?? 0)}
      <span className={styles.kpiSlash}>/</span>
      {usdc(heldUsdc ?? 0)}
    </>
  ) : null;
  const paidSub = ready ? `${int(ob?.paidInvoices ?? pt?.paid ?? 0)} paid · ${int(pt?.limited ?? 0)} limited · ${int(ob?.heldInvoices ?? pt?.held ?? 0)} held${payMode ? ` · ${payMode}` : ""}` : null;

  const s24 = scr ? int(scr.screenings24h) : ready ? int(d.numbers?.screenings ?? 0) : null;
  const highAside = scr ? (
    <span className={`${styles.kpiChip} ${scr.high24h > 0 ? styles.kpiChipHigh : ""}`} title="HIGH-tier verdicts in the last 24 h">
      {scr.high24h} HIGH
    </span>
  ) : undefined;
  const s24Sub = scr ? `${scr.medium24h} medium · ${scr.low24h} low · ${int(scr.screeningsTotal)} all time · ${scr.watchesActive} watch${scr.watchesActive === 1 ? "" : "es"}` : ready ? "all time (24 h breakdown unavailable)" : null;

  const v = d.verify;
  const ledgerValue = v ? int(v.length) : ready ? "—" : null;
  const ledgerAside = v ? (
    v.ok ? (
      <span className={styles.kpiOk} title={`Chain re-walked ${fmtRelative(v.checkedAt)}`}>
        <Icon name="check" size={14} /> intact
      </span>
    ) : (
      <span className={styles.kpiBad}>
        <Icon name="alert" size={14} /> broken at #{v.brokenAt}
      </span>
    )
  ) : undefined;
  const ledgerSub = v ? `hash = keccak256(prev ‖ payload ‖ seq ‖ kind) · verified ${fmtRelative(v.checkedAt)}` : ready ? "verify endpoint unavailable" : null;

  return (
    <div className={styles.kpis}>
      <Kpi label="Earned" value={earned} unit="USDC" sub={earnedSub} />
      <Kpi label="Paid out / held" value={paidValue} unit="USDC" sub={paidSub} />
      <Kpi label="Screenings · 24 h" value={s24} sub={s24Sub} aside={highAside} />
      <Kpi label="Ledger" value={ledgerValue} unit="entries" sub={ledgerSub} aside={ledgerAside} />
    </div>
  );
}

function Ticker({ entries, at, now }: { entries: DecisionLogEntry[] | null; at: number | null; now: number }) {
  return (
    <section className={styles.ticker} aria-label="Latest ledger entries">
      <span className={styles.tickerLabel}>
        <span className={styles.tickerLive} aria-hidden="true" />
        ledger
        {at && <span className={styles.tickerAt}>{Math.max(0, Math.round((now - at) / 1000))}s</span>}
      </span>
      <ol className={styles.tickerList}>
        {entries === null &&
          [0, 1, 2, 3, 4].map((i) => (
            <li key={i} className={styles.tick}>
              <Sk w={150} />
            </li>
          ))}
        {entries?.length === 0 && <li className={`${styles.tick} muted`}>ledger is empty — first screening will appear here</li>}
        {entries?.map((e) => {
          const tier = tierOf(e);
          const who = e.subject ? maskAddress(e.subject) : e.clientId ? e.clientId : "—";
          return (
            <li key={e.id} className={styles.tick}>
              <Link href={`/log/${encodeURIComponent(e.id)}`} className={styles.tickLink} title={`#${e.seq} ${e.kind} · ${fmtTime(e.createdAt)} · ${e.hash}`}>
                <span className={styles.tickSeq}>#{e.seq}</span>
                <span className={styles.tickKind}>{e.kind}</span>
                {tier && <span className={styles.tickTier} data-tier={tier} aria-label={`tier ${tier}`} />}
                <span className={styles.tickWho}>{who}</span>
                <span className={styles.tickWhen}>{fmtRelative(e.createdAt)}</span>
              </Link>
            </li>
          );
        })}
      </ol>
      <Link href="/ledger" className={styles.tickerAll}>
        all →
      </Link>
    </section>
  );
}

function OperatorCard({ d }: { d: ConsoleData }) {
  const latest = d.company?.decisions?.[0] ?? null;
  const op = asOperator(latest);
  const count = d.company?.decisions?.length ?? 0;
  return (
    <section className={`${styles.card} ${styles.primary}`} aria-labelledby="op-h">
      <header className={styles.cardHead}>
        <span className={styles.cardIcon}>
          <Icon name="operator" />
        </span>
        <div className={styles.cardHeadText}>
          <h2 id="op-h" className={styles.cardTitle}>
            Operator · today&apos;s decision
          </h2>
          <p className={styles.cardKicker}>
            {!d.ready ? <Sk w={160} /> : op && latest ? `decided ${fmtRelative(latest.createdAt)} by ${op.meta.fallback ? "deterministic rules" : op.meta.model}` : "the agent has not ticked yet"}
          </p>
        </div>
        {latest && (
          <Link href={`/log/${encodeURIComponent(latest.id)}`} className={`${styles.cardMeta} mono`} title={latest.hash}>
            #{latest.seq} · {short(latest.hash, 8, 4)}
          </Link>
        )}
      </header>

      {!d.ready ? (
        <div className={styles.rationaleSk}>
          <Sk w="100%" />
          <Sk w="92%" />
          <Sk w="70%" />
        </div>
      ) : op ? (
        <>
          <p className={styles.rationale}>{op.rationale}</p>
          <ul className={styles.actions} aria-label="Chosen actions">
            {op.chosen.map((c) => (
              <li key={c.id}>
                <span className={`badge ${c.type === "HOLD" ? "badgeNeutral" : c.ok ? "badgeLOW" : "badgeHIGH"}`}>{ACTION_LABEL[c.type] ?? c.type}</span>
                {c.error && <span className="muted small"> {c.error}</span>}
              </li>
            ))}
          </ul>
          <p className={`${styles.cardFoot} muted small`}>
            next check {fmtRelative(ms(op.nextCheckAt))}
            {op.meta.guardNotes?.length ? ` · guards: ${op.meta.guardNotes.join("; ")}` : ""}
            {op.rejected?.length ? ` · ${op.rejected.length} candidate${op.rejected.length === 1 ? "" : "s"} refused by guards` : ""}
            {count > 1 ? ` · ${count} recent decisions` : ""}
          </p>
        </>
      ) : (
        <p className="muted">
          No operator decision in the ledger yet. The first tick runs via <code>worker/operator.ts</code> or <code>POST /api/internal/operator</code>.
        </p>
      )}

      <Link href="/company" className={styles.cardCta}>
        Open the company <Icon name="arrow" size={14} />
      </Link>
    </section>
  );
}

function MapCard({ d, now }: { d: ConsoleData; now: number }) {
  const m = d.map;
  const graded = m?.graded ?? 0;
  const pct = (n: number) => (graded > 0 ? `${(n / graded) * 100}%` : "0%");
  const tickAt = m?.lastTickAt ? new Date(m.lastTickAt).getTime() : null;
  const stale = tickAt != null && now - tickAt > 6 * 3600_000;
  return (
    <section className={`${styles.card} ${styles.primary}`} aria-labelledby="map-h">
      <header className={styles.cardHead}>
        <span className={styles.cardIcon}>
          <Icon name="map" />
        </span>
        <div className={styles.cardHeadText}>
          <h2 id="map-h" className={styles.cardTitle}>
            Live risk map
          </h2>
          <p className={styles.cardKicker}>{!d.ready ? <Sk w={160} /> : m ? `counterparties receiving USDC on Arc, graded as the chain moves` : "map snapshot unavailable"}</p>
        </div>
        {m && (
          <span className={`${styles.cardMeta} mono`} title={m.lastTick ? `last tick scanned ${m.lastTick.blocksScanned} blocks, ${m.lastTick.logs} transfers, graded ${m.lastTick.graded}` : undefined}>
            {tickAt ? `tick ${fmtRelative(tickAt)}` : "no tick yet"}
            {stale ? " · stale" : ""}
          </span>
        )}
      </header>

      <div className={styles.tierBar} role="img" aria-label={m ? `${m.high} high, ${m.medium} medium, ${m.low} low of ${graded} graded` : "loading"}>
        {m && graded > 0 ? (
          <>
            <span style={{ width: pct(m.high) }} data-tier="HIGH" />
            <span style={{ width: pct(m.medium) }} data-tier="MEDIUM" />
            <span style={{ width: pct(m.low) }} data-tier="LOW" />
          </>
        ) : (
          <span style={{ width: "100%" }} data-tier="NONE" />
        )}
      </div>

      <dl className={styles.tierStats}>
        <div>
          <dt>Graded</dt>
          <dd>{d.ready ? int(graded) : <Sk w={40} />}</dd>
        </div>
        <div>
          <dt>
            <span className={styles.tierKey} data-tier="HIGH" aria-hidden="true" />
            High
          </dt>
          <dd>{d.ready ? int(m?.high ?? 0) : <Sk w={40} />}</dd>
        </div>
        <div>
          <dt>
            <span className={styles.tierKey} data-tier="MEDIUM" aria-hidden="true" />
            Medium
          </dt>
          <dd>{d.ready ? int(m?.medium ?? 0) : <Sk w={40} />}</dd>
        </div>
        <div>
          <dt>
            <span className={styles.tierKey} data-tier="LOW" aria-hidden="true" />
            Low
          </dt>
          <dd>{d.ready ? int(m?.low ?? 0) : <Sk w={40} />}</dd>
        </div>
      </dl>

      <p className={`${styles.cardFoot} muted small`}>
        {m ? (
          <>
            {m.tierChanges24h} tier change{m.tierChanges24h === 1 ? "" : "s"} in 24 h
            {m.cursorBlock != null && (
              <>
                {" "}
                · cursor <span className="mono">#{m.cursorBlock.toLocaleString()}</span>
              </>
            )}
            {m.lastTick?.partial ? " · last tick partial" : ""}
            {m.lastTick?.rateLimited ? " · RPC rate-limited" : ""}
          </>
        ) : d.ready ? (
          "the map worker has not run on this deployment"
        ) : (
          <Sk w={200} />
        )}
      </p>

      <Link href="/map" className={styles.cardCta}>
        Open the Trust Map <Icon name="arrow" size={14} />
      </Link>
    </section>
  );
}

function DeveloperRow({ d }: { d: ConsoleData }) {
  const h = d.health;
  const links: { href: string; icon: IconName; label: string; hint: string; external?: boolean }[] = [
    { href: "/docs", icon: "docs", label: "Docs", hint: "endpoints · verdict · reasons" },
    { href: "/docs/sdk", icon: "sdk", label: "SDK", hint: "@complir/sdk · x402 built in" },
    { href: "/docs/mcp", icon: "mcp", label: "MCP", hint: "@complir/mcp · screen, pay_safely" },
    { href: "/api/v1/health", icon: "api", label: "API status", hint: h ? `${h.ok ? "ok" : h.paused ? "paused" : "degraded"} · ${h.signer?.mode ?? "local"} signer` : d.ready ? "unreachable" : "checking…", external: true },
  ];
  return (
    <section className={styles.dev} aria-labelledby="dev-h">
      <h2 id="dev-h" className={styles.groupTitle}>
        For agents and developers
      </h2>
      <div className={styles.devRow}>
        <div className={styles.devLinks}>
          {links.map((l) =>
            l.external ? (
              <a key={l.href} href={l.href} className={styles.devLink} target="_blank" rel="noopener noreferrer">
                <Icon name={l.icon} size={18} />
                <span className={styles.devLabel}>{l.label}</span>
                <span className={`${styles.devHint} mono`}>{l.hint}</span>
              </a>
            ) : (
              <Link key={l.href} href={l.href} className={styles.devLink}>
                <Icon name={l.icon} size={18} />
                <span className={styles.devLabel}>{l.label}</span>
                <span className={`${styles.devHint} mono`}>{l.hint}</span>
              </Link>
            ),
          )}
        </div>
        <div className={styles.codeChip}>
          <span className={styles.codeLang}>Solidity</span>
          <code className={styles.code}>{SOLIDITY}</code>
          <CopyButton text={SOLIDITY} />
        </div>
      </div>
    </section>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────── */

export function Console() {
  const d = useConsoleData();
  const ticker = useTicker(5);
  const now = useNow(10_000);

  const s = d.company?.snapshot ?? null;
  const h = d.health;
  const latest = d.company?.decisions?.[0] ?? null;
  const decisions = d.company?.decisions?.length ?? 0;
  const pt = d.payouts?.totals ?? null;
  const tips = d.tips;
  const rep = d.report;
  const lastScreen = d.feed?.items?.[0] ?? null;
  const price = h ? (h.x402.disabled ? "free · x402 off" : `${h.x402.priceScreenUsdc} USDC / screen`) : d.ready ? "price unknown" : null;

  const company: CardSpec[] = [
    {
      href: "/company",
      icon: "operator",
      title: "Operator",
      body: "The agent's reserves, obligations, pricing and the reasoning behind every tick.",
      stat: d.ready ? (latest ? `${decisions} decision${decisions === 1 ? "" : "s"} · last ${fmtRelative(latest.createdAt)}` : "no decisions yet") : null,
    },
    {
      href: "/payouts",
      icon: "payouts",
      title: "Guarded Payouts",
      body: "Contributor invoices paid through GuardedTreasury: paid, limited or held, each with a signed reason.",
      stat: d.ready ? (pt ? `${pt.paid} paid · ${pt.limited} limited · ${pt.held} held · ${d.payouts?.mode ?? s?.mode?.treasury ?? "dry-run"}` : "payouts unavailable") : null,
    },
    {
      href: "/report",
      icon: "report",
      title: "Daily report",
      body: "One signed traction report per UTC day, hashed into the ledger and verifiable by anyone.",
      stat: d.ready ? (rep ? `${rep.date}${rep.report?.period?.final === false ? " (running)" : ""} · ${short(rep.hash, 8, 4)}` : "no report published yet") : null,
    },
  ];

  const oracle: CardSpec[] = [
    { href: "/explorer", icon: "explorer", title: "Explorer", body: "Screen one address: dial, reason codes, two-hop funder graph, signed attestation.", stat: price },
    {
      href: "/map",
      icon: "map",
      title: "Trust Map",
      body: "Arc mainnet counterparties graded live and re-graded as they move.",
      stat: d.ready ? (d.map ? `${d.map.graded} graded · ${d.map.high} high · ${d.map.tierChanges24h} changes 24 h` : "map unavailable") : null,
    },
    { href: "/shadow", icon: "shadow", title: "Shadow report", body: "Paste a payee book and recent payments: what would we have held or limited?", stat: d.ready ? "free · up to 50 addresses" : null },
    { href: "/badge", icon: "badge", title: "Badge", body: "Screened-by-CompliR SVG and embed snippets linked to the live attestation.", stat: d.ready ? "free · cached 60 s" : null },
    {
      href: "/tips",
      icon: "tips",
      title: "Tips",
      body: "Staked community intelligence: a verified tip earns a bounty, a bad one loses its stake.",
      stat: d.ready ? (tips ? `${tips.totals.total} tip${tips.totals.total === 1 ? "" : "s"} · ${usdc(tips.totals.paidUsdc, 3)} USDC paid · stake ${tips.config.stakeUsdc}` : "tips unavailable") : null,
    },
  ];

  const records: CardSpec[] = [
    {
      href: "/ledger",
      icon: "ledger",
      title: "Ledger",
      body: "Hash-chained decision log, Merkle-anchored on Arc. Re-walk the chain, replay any verdict.",
      stat: d.ready ? (d.verify ? (d.verify.ok ? `${int(d.verify.length)} entries · chain intact` : `BROKEN at seq ${d.verify.brokenAt}`) : "verify unavailable") : null,
    },
    {
      href: "/feed",
      icon: "feed",
      title: "Feed",
      body: "Anonymised recent screenings, addresses masked, payer class shown.",
      stat: d.ready ? (lastScreen ? `last ${lastScreen.tier} ${lastScreen.score} · ${fmtRelative(lastScreen.screenedAt)}` : "no screenings yet") : null,
    },
    {
      href: "/numbers",
      icon: "numbers",
      title: "Numbers",
      body: "Honest public counters. Own wallets always excluded.",
      stat: d.ready ? (d.numbers ? `${int(d.numbers.screenings)} screenings · ${int(d.numbers.outsidePayers)} outside payers` : "numbers unavailable") : null,
    },
  ];

  return (
    <div className={`container ${styles.page}`}>
      <header className={styles.head}>
        <div>
          <p className={styles.eyebrow}>CompliR · operations console</p>
          <h1 className={styles.h1}>A company run by an agent, in one view.</h1>
          <p className={styles.lede}>
            The first company on Arc run end to end by an agent. Its product is risk screening; its books are a signed ledger.
          </p>
        </div>
        <div className={styles.headAside}>
          <span className="muted small">
            {d.updatedAt ? `updated ${fmtRelative(d.updatedAt)}` : "loading…"} · every {CONSOLE_REFRESH_MS / 1000} s
          </span>
          <Link href="/" className="btn btnSmall">
            About CompliR
          </Link>
        </div>
      </header>

      <StatusBar d={d} now={now} />
      <Kpis d={d} />
      <Ticker entries={ticker.entries} at={ticker.at} now={now} />

      <div className={styles.primaryRow}>
        <OperatorCard d={d} />
        <MapCard d={d} now={now} />
      </div>

      <Group id="company" label="The company" blurb="Operator decisions, a guarded treasury, a signed daily report." cards={company} />
      <Group id="oracle" label="The oracle" blurb="Counterparty risk on Arc, graded and signed. The product the company sells." cards={oracle} />
      <Group id="records" label="The records" blurb="Everything above, hash-chained and replayable." cards={records} />

      <DeveloperRow d={d} />
    </div>
  );
}
