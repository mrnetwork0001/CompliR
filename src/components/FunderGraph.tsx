"use client";
/**
 * FunderGraph - the verdict's funding evidence as a 2-hop radial instrument (same language as the hero lattice and
 * the Trust Map): subject at the centre, HOP 1 / HOP 2 rings, each funder a ring + core mark (core ∝ log amount),
 * flagged funders (sanctions / USDC blacklist / protocol blocklist) in --high with a pixel alert mark, every path a
 * dashed hairline flowing toward the subject (hop 2 → hop 1 → subject), amounts on hover, mono totals readout.
 * Pure SVG + CSS animation (ds-flow), scales via viewBox down to 320 px; coordinates rounded to 2 dp.
 */
import { useState } from "react";
import type { Address, EvidenceBundle } from "@/lib/types";
import { Glyph } from "./Glyph";
import { short } from "./api";
import styles from "./FunderGraph.module.css";

interface Node {
  address: Address;
  hop: 0 | 1 | 2;
  flagged: boolean;
  parent: Address | null;
  x: number;
  y: number;
  angle: number;
  /** filled core radius ∝ log(amount) */
  core: number;
  /** outer ring radius */
  r: number;
  amount: number | null;
  txHash?: string;
  flags: string[];
}
interface Edge {
  from: Node;
  to: Node;
  flagged: boolean;
  amount: number | null;
}

const W = 440;
const H = 440;
const CX = W / 2;
const CY = H / 2;
const R1 = 112;
const R2 = 190;
const r2 = (v: number) => Math.round(v * 100) / 100;
const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { maximumFractionDigits: d });

function flagsOf(f: EvidenceBundle["subject"]): string[] {
  const out: string[] = [];
  if (f.sanctions.length > 0) out.push("SANCTIONS");
  if (f.usdcBlacklisted) out.push("USDC BLACKLIST");
  if (f.protocolBlocklisted) out.push("PROTOCOL BLOCKLIST");
  return out;
}
function polar(r: number, angle: number): { x: number; y: number } {
  return { x: r2(CX + r * Math.cos(angle)), y: r2(CY + r * Math.sin(angle)) };
}
function coreOf(amount: number | null, hop: 1 | 2): number {
  const base = hop === 1 ? 2.6 : 2.1;
  const r = base + 1.9 * Math.log10(1 + Math.max(0, amount ?? 0));
  return r2(Math.min(9, Math.max(base, r)));
}

/**
 * Lay out the evidence bundle as rings: subject in the centre, direct funders on ring 1 (evenly spaced, biggest
 * amount first from 12 o'clock), their funders on ring 2 clustered around the hop-1 node they funded.
 */
export function layoutGraph(ev: EvidenceBundle): { nodes: Node[]; edges: Edge[] } {
  const subjFlags = flagsOf(ev.subject);
  const subject: Node = { address: ev.subject.address, hop: 0, flagged: subjFlags.length > 0, parent: null, x: CX, y: CY, angle: 0, core: 7, r: 14, amount: null, flags: subjFlags };
  const hop1 = [...ev.funders.filter((f) => f.hop === 1)];
  const hop2 = ev.funders.filter((f) => f.hop === 2);
  const amountOf = (f: EvidenceBundle["funders"][number]) => {
    const hop = f.path.find((h) => h.from === f.facts.address) ?? f.path[0];
    const n = hop ? Number(hop.amountUsdc) : NaN;
    return { amount: Number.isFinite(n) ? n : null, txHash: hop?.txHash };
  };
  hop1.sort((a, b) => (amountOf(b).amount ?? 0) - (amountOf(a).amount ?? 0) || a.facts.address.localeCompare(b.facts.address));

  const nodes: Node[] = [subject];
  const byAddr = new Map<Address, Node>([[subject.address, subject]]);
  const n1 = hop1.length;
  hop1.forEach((f, i) => {
    if (byAddr.has(f.facts.address)) return;
    const angle = -Math.PI / 2 + (i / Math.max(1, n1)) * 2 * Math.PI;
    const { amount, txHash } = amountOf(f);
    const core = coreOf(amount, 1);
    const flags = flagsOf(f.facts);
    const node: Node = { address: f.facts.address, hop: 1, flagged: flags.length > 0, parent: subject.address, ...polar(R1, angle), angle, core, r: core + 4, amount, txHash, flags };
    nodes.push(node);
    byAddr.set(node.address, node);
  });

  // group hop-2 by parent (the hop-1 wallet they funded)
  const groups = new Map<Address, typeof hop2>();
  for (const f of hop2) {
    const hop = f.path.find((h) => h.from === f.facts.address);
    const parent = hop && byAddr.has(hop.to) && hop.to !== subject.address ? hop.to : null;
    const key = parent ?? subject.address;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const n2 = hop2.length;
  let placed = 0;
  for (const [parentAddr, list] of groups) {
    const parent = byAddr.get(parentAddr)!;
    const baseAngle = parent.hop === 0 ? -Math.PI / 2 : parent.angle;
    const spread = parent.hop === 0 ? 2 * Math.PI : Math.min((2 * Math.PI) / Math.max(1, n1), 1.3);
    list.forEach((f, i) => {
      if (byAddr.has(f.facts.address)) return;
      const angle = parent.hop === 0 ? baseAngle + (placed / Math.max(1, n2)) * 2 * Math.PI : baseAngle + (i - (list.length - 1) / 2) * (spread / Math.max(1, list.length));
      placed++;
      const { amount, txHash } = amountOf(f);
      const core = coreOf(amount, 2);
      const flags = flagsOf(f.facts);
      const node: Node = { address: f.facts.address, hop: 2, flagged: flags.length > 0, parent: parent.address, ...polar(R2, angle), angle, core, r: core + 3, amount, txHash, flags };
      nodes.push(node);
      byAddr.set(node.address, node);
    });
  }

  const edges: Edge[] = nodes.filter((n) => n.parent).map((n) => ({ from: n, to: byAddr.get(n.parent!)!, flagged: n.flagged, amount: n.amount }));
  return { nodes, edges };
}

/** straight path from a funder to the mark it funded, trimmed at both marks (dash motion = toward the subject) */
function edgePath(a: Node, b: Node): { d: string; mx: number; my: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist, uy = dy / dist;
  const x1 = a.x + ux * (a.r + 1), y1 = a.y + uy * (a.r + 1);
  const x2 = b.x - ux * (b.r + 3), y2 = b.y - uy * (b.r + 3);
  return { d: `M${r2(x1)} ${r2(y1)} L${r2(x2)} ${r2(y2)}`, mx: r2((x1 + x2) / 2), my: r2((y1 + y2) / 2) };
}

export function FunderGraph({ evidence, onSelect }: { evidence: EvidenceBundle; onSelect?: (address: Address) => void }) {
  const { nodes, edges } = layoutGraph(evidence);
  const [hovered, setHovered] = useState<Address | null>(null);
  const funders = nodes.filter((n) => n.hop > 0);
  const flagged = funders.filter((n) => n.flagged);
  const hop1Total = funders.filter((n) => n.hop === 1).reduce((s, n) => s + (n.amount ?? 0), 0);
  const flaggedTotal = flagged.reduce((s, n) => s + (n.amount ?? 0), 0);
  const chain = new Set<Address>();
  if (hovered) {
    let cur = nodes.find((n) => n.address === hovered) ?? null;
    while (cur) { chain.add(cur.address); cur = cur.parent ? nodes.find((n) => n.address === cur!.parent) ?? null : null; }
  }
  const readout = [
    `${funders.length} FUNDER${funders.length === 1 ? "" : "S"}`,
    `${flagged.length} FLAGGED`,
    flagged.length > 0 ? `${fmt(flaggedTotal)} USDC VIA ${short(flagged[0].address, 4, 4)}` : `${fmt(hop1Total)} USDC IN`,
    `DEPTH ${evidence.depth}`,
  ].join(" · ");

  return (
    <figure className={styles.figure}>
      <div className={styles.readout} aria-live="polite">
        <span className={styles.readoutKey}>FUNDERS</span>
        <span className={styles.readoutVal}>{readout}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img" aria-label={`Funder graph: ${funders.length} funding wallet${funders.length === 1 ? "" : "s"} within ${evidence.depth} hop${evidence.depth === 1 ? "" : "s"}, ${flagged.length} flagged`}>
        <defs>
          <marker id="fg-head" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0 0.5 L5.5 3 L0 5.5 z" className={styles.head} />
          </marker>
          <marker id="fg-head-hot" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0 0.5 L5.5 3 L0 5.5 z" className={styles.headHot} />
          </marker>
          <marker id="fg-head-high" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0 0.5 L5.5 3 L0 5.5 z" className={styles.headHigh} />
          </marker>
        </defs>
        {/* corner brackets */}
        {([[8, 8, 1, 1], [W - 8, 8, -1, 1], [8, H - 8, 1, -1], [W - 8, H - 8, -1, -1]] as const).map(([x, y, dx, dy], i) => (
          <path key={i} d={`M${x + dx * 9} ${y} H${x} V${y + dy * 9}`} className={styles.bracket} />
        ))}
        {/* rings */}
        <circle cx={CX} cy={CY} r={R2 + 22} className={styles.ringOuter} />
        {[R1, R2].map((r) => <circle key={r} cx={CX} cy={CY} r={r} className={styles.ring} />)}
        {Array.from({ length: 12 }, (_, i) => (i / 12) * Math.PI * 2).map((a) => (
          <line key={a} x1={r2(CX + Math.cos(a) * (R2 + 18))} y1={r2(CY + Math.sin(a) * (R2 + 18))} x2={r2(CX + Math.cos(a) * (R2 + 22))} y2={r2(CY + Math.sin(a) * (R2 + 22))} className={styles.tick} />
        ))}
        <text x={CX + R1 + 5} y={CY - 5} className={styles.ringLabel}>HOP 1 · {funders.filter((n) => n.hop === 1).length}</text>
        <text x={CX + R2 + 5} y={CY - 5} className={styles.ringLabel}>HOP 2 · {funders.filter((n) => n.hop === 2).length}</text>

        {/* paths: funder → funded mark, dashes flow toward the subject */}
        {edges.map((e, i) => {
          const p = edgePath(e.from, e.to);
          const hot = hovered != null && chain.has(e.from.address);
          const dim = hovered != null && !hot;
          return (
            <path key={i} d={p.d} className={`${styles.edge} ${e.flagged ? styles.edgeHigh : ""} ${hot ? styles.edgeHot : ""} ${dim ? styles.edgeDim : ""}`} markerEnd={hot ? "url(#fg-head-hot)" : e.flagged ? "url(#fg-head-high)" : "url(#fg-head)"} />
          );
        })}

        {/* marks */}
        {nodes.map((n) => {
          const isHov = hovered === n.address;
          const inChain = chain.has(n.address);
          const dim = hovered != null && !inChain;
          const out = n.hop === 0 ? false : Math.cos(n.angle) >= 0;
          const lx = n.hop === 0 ? CX : r2(n.x + Math.cos(n.angle) * (n.r + 5));
          const ly = n.hop === 0 ? CY + n.r + 14 : r2(n.y + Math.sin(n.angle) * (n.r + 5) + 3);
          const tip = [n.hop === 0 ? "Subject" : `Hop ${n.hop} funder`, n.address, n.amount != null ? `${fmt(n.amount)} USDC` : null, n.flags.length ? `FLAGGED: ${n.flags.join(", ")}` : null].filter(Boolean).join("\n");
          const cls = n.hop === 0 ? styles.subject : n.flagged ? styles.flagged : n.hop === 1 ? styles.hop1 : styles.hop2;
          return (
            <g
              key={n.address}
              className={`${styles.mark} ${cls} ${dim ? styles.markDim : ""}`}
              onClick={onSelect ? () => onSelect(n.address) : undefined}
              role={onSelect ? "button" : undefined}
              tabIndex={onSelect ? 0 : undefined}
              aria-label={onSelect ? `Screen ${short(n.address)}` : undefined}
              onKeyDown={onSelect ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(n.address); } } : undefined}
              onMouseEnter={() => setHovered(n.address)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(n.address)}
              onBlur={() => setHovered(null)}
            >
              <title>{tip}</title>
              <circle cx={n.x} cy={n.y} r={n.r + 5} fill="transparent" />
              <circle cx={n.x} cy={n.y} r={n.r} className={`${styles.markRing} ${isHov ? styles.markRingHot : ""}`} />
              <circle cx={n.x} cy={n.y} r={n.core} className={styles.markCore} />
              {n.flagged && (
                <g transform={`translate(${r2(n.x + n.r * 0.55)} ${r2(n.y - n.r - 7)})`}>
                  <Glyph name="alert" tone="high" size={10} />
                </g>
              )}
              {n.hop === 0 ? (
                <g transform={`translate(${CX - 56} ${ly - 11})`}>
                  <rect width="112" height="16" className={styles.chip} />
                  <text x="56" y="11.5" textAnchor="middle" className={styles.chipText}>SUBJECT {short(n.address, 6, 4)}</text>
                </g>
              ) : (
                <text x={lx} y={ly} textAnchor={out ? "start" : "end"} className={styles.label}>{short(n.address, 6, 4)}</text>
              )}
            </g>
          );
        })}

        {/* amount labels along the hovered chain */}
        {hovered && edges.filter((e) => chain.has(e.from.address) && e.amount != null).map((e, i) => {
          const p = edgePath(e.from, e.to);
          const txt = `${fmt(e.amount!, e.amount! < 100 ? 2 : 0)} USDC`;
          const w = r2(txt.length * 5.2 + 8);
          return (
            <g key={`a${i}`} transform={`translate(${r2(p.mx - w / 2)} ${r2(p.my - 7)})`} pointerEvents="none">
              <rect width={w} height={13} className={styles.amountBg} />
              <text x={r2(w / 2)} y={9.5} textAnchor="middle" className={styles.amount}>{txt}</text>
            </g>
          );
        })}
        {!hovered && funders.length === 0 && (
          <text x={CX} y={CY + R1 + 40} textAnchor="middle" className={styles.empty}>NO INBOUND USDC FUNDERS WITHIN DEPTH {evidence.depth}</text>
        )}
      </svg>
      <figcaption className={styles.legend}>
        <span><i className={styles.swSubject} /> subject</span>
        <span><i className={styles.swFunder} /> funder · core ∝ log usdc</span>
        <span><i className={styles.swFlagged} /> sanctioned / blacklisted</span>
        <span><i className={styles.swFlow} /> usdc flows toward subject</span>
        <span className={styles.legendHint}>hover a mark for amounts{onSelect ? " · click to screen" : ""}</span>
      </figcaption>
    </figure>
  );
}
