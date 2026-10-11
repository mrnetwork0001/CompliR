"use client";

import type { Address, EvidenceBundle } from "@/lib/types";
import { short } from "./api";
import styles from "./FunderGraph.module.css";

interface Node {
  address: Address;
  hop: 0 | 1 | 2;
  tainted: boolean;
  parent: Address | null;
  label: string;
  x: number;
  y: number;
  amountUsdc?: string;
  txHash?: string;
}

const W = 420;
const H = 420;
const CX = W / 2;
const CY = H / 2;
const R1 = 105;
const R2 = 180;

function isTainted(f: EvidenceBundle["subject"]): boolean {
  return f.sanctions.length > 0 || f.usdcBlacklisted || f.protocolBlocklisted;
}

function polar(r: number, angle: number): { x: number; y: number } {
  return { x: CX + r * Math.cos(angle), y: CY + r * Math.sin(angle) };
}

/**
 * Lay out the evidence bundle as rings: subject in the centre, direct funders on ring 1, their funders on ring 2.
 * Hop-2 nodes are clustered around the hop-1 node they funded. Tainted nodes (sanctions / USDC blacklist /
 * protocol blocklist) are drawn red.
 */
export function layoutGraph(ev: EvidenceBundle): { nodes: Node[]; edges: { from: Node; to: Node; tainted: boolean }[] } {
  const subject: Node = { address: ev.subject.address, hop: 0, tainted: isTainted(ev.subject), parent: null, label: short(ev.subject.address), x: CX, y: CY };
  const hop1 = ev.funders.filter((f) => f.hop === 1);
  const hop2 = ev.funders.filter((f) => f.hop === 2);

  const nodes: Node[] = [subject];
  const byAddr = new Map<Address, Node>([[subject.address, subject]]);

  const n1 = hop1.length;
  hop1.forEach((f, i) => {
    const angle = -Math.PI / 2 + (i / Math.max(1, n1)) * 2 * Math.PI;
    const { x, y } = polar(R1, angle);
    const hop = f.path.find((h) => h.from === f.facts.address) ?? f.path[0];
    const node: Node = {
      address: f.facts.address,
      hop: 1,
      tainted: isTainted(f.facts),
      parent: subject.address,
      label: short(f.facts.address),
      x,
      y,
      amountUsdc: hop?.amountUsdc,
      txHash: hop?.txHash,
    };
    if (!byAddr.has(node.address)) {
      nodes.push(node);
      byAddr.set(node.address, node);
    }
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
    const baseAngle = parent.hop === 0 ? -Math.PI / 2 : Math.atan2(parent.y - CY, parent.x - CX);
    const spread = parent.hop === 0 ? 2 * Math.PI : Math.min((2 * Math.PI) / Math.max(1, hop1.length), 1.2);
    list.forEach((f, i) => {
      const angle = parent.hop === 0 ? baseAngle + (placed / Math.max(1, n2)) * 2 * Math.PI : baseAngle + (i - (list.length - 1) / 2) * (spread / Math.max(1, list.length));
      placed++;
      const { x, y } = polar(R2, angle);
      const hop = f.path.find((h) => h.from === f.facts.address) ?? f.path[0];
      const node: Node = {
        address: f.facts.address,
        hop: 2,
        tainted: isTainted(f.facts),
        parent: parent.address,
        label: short(f.facts.address),
        x,
        y,
        amountUsdc: hop?.amountUsdc,
        txHash: hop?.txHash,
      };
      if (!byAddr.has(node.address)) {
        nodes.push(node);
        byAddr.set(node.address, node);
      }
    });
  }

  const edges = nodes
    .filter((n) => n.parent)
    .map((n) => ({ from: n, to: byAddr.get(n.parent!)!, tainted: n.tainted }));
  return { nodes, edges };
}

export function FunderGraph({ evidence, onSelect }: { evidence: EvidenceBundle; onSelect?: (address: Address) => void }) {
  const { nodes, edges } = layoutGraph(evidence);
  const funders = nodes.length - 1;

  return (
    <figure className={styles.figure}>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img" aria-label={`Funder graph: ${funders} funding wallet${funders === 1 ? "" : "s"} within ${evidence.depth} hop${evidence.depth === 1 ? "" : "s"}`}>
        <circle cx={CX} cy={CY} r={R1} className={styles.ring} />
        <circle cx={CX} cy={CY} r={R2} className={styles.ring} />
        <text x={CX + R1 + 4} y={CY - 4} className={styles.ringLabel}>hop 1</text>
        <text x={CX + R2 + 4} y={CY - 4} className={styles.ringLabel}>hop 2</text>
        {edges.map((e, i) => (
          <line key={i} x1={e.from.x} y1={e.from.y} x2={e.to.x} y2={e.to.y} className={e.tainted ? styles.edgeTainted : styles.edge} markerEnd="url(#arrow)" />
        ))}
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" className={styles.arrow} />
          </marker>
        </defs>
        {nodes.map((n) => {
          const r = n.hop === 0 ? 20 : n.hop === 1 ? 14 : 11;
          const cls = n.tainted ? styles.nodeTainted : n.hop === 0 ? styles.nodeSubject : styles.node;
          const tip = [n.hop === 0 ? "Subject" : `Hop ${n.hop} funder`, n.address, n.amountUsdc ? `${n.amountUsdc} USDC` : null, n.tainted ? "TAINTED: sanctions / blacklist" : null]
            .filter(Boolean)
            .join("\n");
          return (
            <g key={n.address} className={styles.nodeGroup} onClick={onSelect ? () => onSelect(n.address) : undefined} role={onSelect ? "button" : undefined} tabIndex={onSelect ? 0 : undefined}
              onKeyDown={onSelect ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(n.address); } } : undefined}>
              <title>{tip}</title>
              <circle cx={n.x} cy={n.y} r={r} className={cls} />
              {n.tainted && <text x={n.x} y={n.y + 4} textAnchor="middle" className={styles.bang}>!</text>}
              <text x={n.x} y={n.y + r + 13} textAnchor="middle" className={styles.label}>{n.label}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className={styles.legend}>
        <span><i className={styles.swSubject} /> subject</span>
        <span><i className={styles.swNode} /> funder</span>
        <span><i className={styles.swTainted} /> sanctioned / blacklisted</span>
        <span className="muted">depth {evidence.depth} · {funders} wallet{funders === 1 ? "" : "s"}</span>
      </figcaption>
      {funders === 0 && <p className="muted small">No inbound USDC funders found on Arc within the explored depth.</p>}
    </figure>
  );
}
