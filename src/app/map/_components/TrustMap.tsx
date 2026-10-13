"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "@/lib/types";
import type { MapCandidate, MapNode, MapSnapshot, TierChange } from "@/lib/trustmap/types";
import type { HealthResponse } from "@/app/api/_lib/public-types";
import { TierBadge } from "@/components/TierBadge";
import { HttpError, apiFetch, fmtRelative, getHealth, short } from "@/components/api";
import { MapCanvas } from "./MapCanvas";
import { NodePanel, type PanelItem } from "./NodePanel";
import styles from "./TrustMap.module.css";

const REFRESH_MS = 15_000;

type TickResult = {
  blocksScanned: number; fromBlock: number | null; toBlock: number | null; logs: number; recipients: number; candidates: number; graded: number;
  skippedContracts: number; skippedRecent: number; skippedBudget: number; tierChanges: number; edges: number; observedNow: number; observed?: number; rpcCalls: number; partial: boolean; rateLimited: boolean; seeded: boolean; tookMs: number;
  gradedNodes: { address: Address; tier: "LOW" | "MEDIUM" | "HIGH"; score: number; changed: boolean }[];
  failures: { address: Address; error: string }[];
};

export function TrustMap() {
  const [snap, setSnap] = useState<MapSnapshot | null>(null);
  const [changes, setChanges] = useState<TierChange[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [selected, setSelected] = useState<Address | null>(null);
  const [hovered, setHovered] = useState<Address | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const inflight = useRef(false);

  const load = useCallback(() => {
    if (inflight.current) return Promise.resolve();
    inflight.current = true;
    return Promise.all([apiFetch<MapSnapshot>("/api/v1/map?limit=150&candidates=200"), apiFetch<{ items: TierChange[] }>("/api/v1/map/changes?limit=30")])
      .then(([s, c]) => {
        setSnap(s);
        setChanges(c.items);
        setError(null);
        setUpdatedAt(Date.now());
        setNow(Math.floor(Date.now() / 1000));
      })
      .catch((e: unknown) => {
        setError(e instanceof HttpError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        inflight.current = false;
      });
  }, []);

  useEffect(() => {
    void load();
    let alive = true;
    getHealth().then((h) => alive && setHealth(h));
    return () => { alive = false; };
  }, [load]);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    const onVis = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [load, paused]);

  const explorerUrl = health?.network.explorerUrl ?? "";
  const nodes = useMemo(() => snap?.nodes ?? [], [snap]);
  const candidates = useMemo(() => snap?.candidates ?? [], [snap]);
  const edges = useMemo(() => snap?.edges ?? [], [snap]);
  const items = useMemo(() => {
    const m = new Map<Address, PanelItem>();
    for (const c of candidates) m.set(c.address, { kind: "candidate", candidate: c satisfies MapCandidate });
    for (const n of nodes) m.set(n.address, { kind: "node", node: n satisfies MapNode });
    return m;
  }, [nodes, candidates]);
  const focusItem = (selected && items.get(selected)) || (hovered && items.get(hovered)) || null;
  const focusAddr = focusItem ? (focusItem.kind === "node" ? focusItem.node.address : focusItem.candidate.address) : null;
  const stats = snap?.stats;
  const empty = snap !== null && nodes.length === 0 && candidates.length === 0;

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <p className="kicker" style={{ marginBottom: 8 }}><span className="live-dot" aria-hidden="true" />oracle · trust map · Arc 5042</p>
          <h1>Arc Trust Map</h1>
          <p className="muted">
            Live, chain-wide view: every tick tails new Arc blocks, records every USDC recipient it sees, grades the biggest with the CompliR pipeline and places them on their tier ring.
            Core ∝ USDC received in 24h · dashed signal lines are USDC transfers flowing toward the recipient · faint marks on the outer ring are observed, not graded yet.
          </p>
        </div>
        <div className={styles.controls}>
          <span className="muted small" aria-live="polite">
            {updatedAt ? `Updated ${fmtRelative(updatedAt)}` : "Loading…"} · refreshes every 15s
          </span>
          <button type="button" className="btn btnSmall" onClick={() => setPaused((p) => !p)}>{paused ? "Resume" : "Pause"}</button>
          <button type="button" className="btn btnSmall" onClick={() => void load()}>Refresh</button>
        </div>
      </div>

      {error && <div className={`alert alertError ${styles.block}`}>Could not load the map: {error}</div>}

      <div className={styles.stats} aria-label="Map statistics">
        <Stat label="Graded" value={stats?.graded} />
        <Stat label="High" value={stats?.high} tone="HIGH" />
        <Stat label="Medium" value={stats?.medium} tone="MEDIUM" />
        <Stat label="Low" value={stats?.low} tone="LOW" />
        <Stat label="Observed" value={stats?.observed} />
        <Stat label="Tier changes 24h" value={stats?.tierChanges24h} />
        <Stat label="Cursor block" value={stats?.cursorBlock ?? undefined} mono />
        <Stat label="Last tick" value={stats ? (stats.lastTickAt ? fmtRelative(stats.lastTickAt) : "never") : undefined} />
      </div>

      <Ticker changes={changes} onPick={(a) => setSelected(a)} />

      {empty ? (
        <EmptyState lastTick={stats?.lastTick ?? null} onDone={() => void load()} />
      ) : (
        <div className={styles.body}>
          <div className={styles.mapCard}>
            {snap ? (
              <MapCanvas nodes={nodes} candidates={candidates} edges={edges} stats={stats ?? null} selected={selected} hovered={hovered} now={now} onSelect={setSelected} onHover={setHovered} />
            ) : (
              <div className={styles.loading}><span className="skeleton" style={{ width: "40%" }} /></div>
            )}
            <div className={styles.mapFoot}>
              <span>{nodes.length} graded · {candidates.length} observed · {edges.length} edges{stats?.lastTick?.partial ? " · last tick partial (RPC limit)" : ""}</span>
              <span>angle = hash(address) · core ∝ log USDC in · sweep 20 s</span>
            </div>
          </div>
          <aside className={styles.panel} aria-live="polite">
            {focusItem ? (
              <NodePanel item={focusItem} pinned={selected === focusAddr} explorerUrl={explorerUrl} onClose={() => setSelected(null)} onPick={(a) => setSelected(a)} onPromoted={() => void load()} />
            ) : (
              <div className={styles.panelHint}>
                <div className={styles.sectionTitle}>Pick a counterparty</div>
                <p className="muted small">Hover a mark for a preview, click to pin it: score, reason codes, last block, transfers on the map and a one-click jump into the Explorer. Faint marks on the outer ring are observed addresses - pin one and screen it on the spot.</p>
                {stats?.lastTick && (
                  <p className="muted small">
                    Last tick scanned blocks {stats.lastTick.fromBlock?.toLocaleString()}–{stats.lastTick.toBlock?.toLocaleString()}: {stats.lastTick.logs} USDC transfers, {stats.lastTick.recipients} recipients, {stats.lastTick.candidates} above threshold, {stats.lastTick.graded} graded, {stats.lastTick.observed ?? 0} observed on file ({stats.lastTick.rpcCalls} RPC calls{stats.lastTick.rateLimited ? ", rate-limited" : ""}).
                  </p>
                )}
                <TopList nodes={nodes} onPick={(a) => setSelected(a)} />
              </div>
            )}
          </aside>
        </div>
      )}

      <details className={styles.dev}>
        <summary className="muted small">Operator: run one tailer tick now</summary>
        <RunTick onDone={() => void load()} />
      </details>
    </div>
  );
}

function Stat({ label, value, tone, mono }: { label: string; value: number | string | undefined; tone?: "HIGH" | "MEDIUM" | "LOW"; mono?: boolean }) {
  return (
    <div className={`${styles.stat} ${tone ? styles[`stat${tone}`] : ""}`}>
      <div className={styles.statLabel}>{label}</div>
      <div className={`${styles.statValue} ${mono ? "mono" : ""}`}>{value === undefined ? <span className="skeleton" style={{ width: "3ch" }} /> : typeof value === "number" ? value.toLocaleString() : value}</div>
    </div>
  );
}

function Ticker({ changes, onPick }: { changes: TierChange[]; onPick: (a: Address) => void }) {
  return (
    <div className={styles.ticker} aria-label="Recent tier changes">
      <span className={styles.tickerTag}><i className={styles.liveDot} /> Tier changes</span>
      <div className={styles.tickerTrack}>
        {changes.length === 0 && <span className="muted small">None yet - nodes are regraded after the regrade window; changes show up here as they happen.</span>}
        {changes.map((c) => (
          <button key={c.id} type="button" className={styles.tickerItem} onClick={() => onPick(c.address)} title={c.address}>
            <span className="mono">{short(c.address)}</span> <TierBadge tier={c.from} size="sm" /> → <TierBadge tier={c.to} size="sm" />
            <span className="muted small"> {fmtRelative(c.at)}{c.source === "demo" ? " · demo" : ""}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TopList({ nodes, onPick }: { nodes: MapSnapshot["nodes"]; onPick: (a: Address) => void }) {
  const top = nodes.slice(0, 8);
  if (!top.length) return null;
  return (
    <div>
      <div className={styles.sectionTitle}>Biggest USDC recipients</div>
      <ul className={styles.edgeList}>
        {top.map((n) => (
          <li key={n.address}>
            <button type="button" className={styles.linkBtn} onClick={() => onPick(n.address)} title={n.address}>{short(n.address)}</button>{" "}
            <TierBadge tier={n.tier} size="sm" /> <span className="muted small">{n.usdcIn24h.toLocaleString(undefined, { maximumFractionDigits: 0 })} USDC</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyState({ lastTick, onDone }: { lastTick: MapSnapshot["stats"]["lastTick"]; onDone: () => void }) {
  return (
    <div className={`card ${styles.empty}`}>
      <h2>The tailer is warming up</h2>
      <p className="muted">
        Nothing graded yet. The Trust Map fills up as the tailer runs: each tick reads the latest Arc blocks, selects wallets that received ≥ 25 USDC, and grades up to five of them with the full CompliR pipeline.
        Start it with <code>npx tsx --env-file=.env.local worker/trustmap.ts</code>, schedule <code>POST /api/internal/trustmap</code>, or run one tick right here.
      </p>
      {lastTick && (
        <p className="muted small">
          Last tick {fmtRelative(lastTick.at)}: scanned {lastTick.blocksScanned} blocks, {lastTick.recipients} recipients, {lastTick.candidates} candidates, {lastTick.graded} graded{lastTick.rateLimited ? " - RPC rate-limited, backing off" : ""}.
        </p>
      )}
      <RunTick onDone={onDone} />
    </div>
  );
}

function RunTick({ onDone }: { onDone: () => void }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/internal/trustmap", { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
      const body = (await res.json()) as TickResult | { error?: { code?: string; message?: string } };
      if (!res.ok || "error" in body) {
        const err = (body as { error?: { code?: string; message?: string } }).error;
        setMsg({ ok: false, text: `${err?.code ?? res.status}: ${err?.message ?? "tick failed"}` });
      } else {
        const r = body as TickResult;
        const graded = r.gradedNodes.map((g) => `${short(g.address)}=${g.tier}`).join(", ");
        setMsg({
          ok: true,
          text: `Scanned ${r.blocksScanned} blocks (${r.fromBlock ?? "-"}→${r.toBlock ?? "-"}): ${r.logs} transfers, ${r.recipients} recipients, ${r.candidates} ≥ threshold, ${r.graded} graded${graded ? ` (${graded})` : ""}, skipped ${r.skippedRecent} recent / ${r.skippedContracts} contracts, ${r.tierChanges} tier changes, ${r.edges} new edges, ${r.observedNow} observed, ${r.rpcCalls} RPC calls${r.partial ? ", partial" : ""}${r.rateLimited ? ", rate-limited" : ""}${r.seeded ? ", demo seeded" : ""} in ${(r.tookMs / 1000).toFixed(1)}s.`,
        });
        onDone();
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.runTick} onSubmit={(e) => { e.preventDefault(); void run(); }}>
      <input className="input" type="password" autoComplete="off" placeholder="CRON_SECRET" value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="CRON_SECRET" />
      <button type="submit" className="btn btnPrimary" disabled={busy || !secret}>{busy ? "Running tick…" : "Run one tick"}</button>
      {msg && <div className={`alert ${msg.ok ? "alertInfo" : "alertError"} ${styles.runMsg}`}>{msg.text}</div>}
    </form>
  );
}
