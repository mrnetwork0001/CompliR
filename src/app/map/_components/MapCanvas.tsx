"use client";

import { useMemo } from "react";
import type { Address } from "@/lib/types";
import { layoutMap, LAYOUT_H, LAYOUT_W } from "@/lib/trustmap/layout";
import type { MapEdge, MapNode } from "@/lib/trustmap/types";
import { short } from "@/components/api";
import styles from "./TrustMap.module.css";

const DAY = 86_400;

export function MapCanvas({
  nodes, edges, selected, hovered, now, onSelect, onHover,
}: {
  nodes: MapNode[]; edges: MapEdge[]; selected: Address | null; hovered: Address | null; now: number;
  onSelect: (a: Address | null) => void; onHover: (a: Address | null) => void;
}) {
  const layout = useMemo(() => layoutMap(nodes, edges), [nodes, edges]);
  const byAddr = useMemo(() => new Map(nodes.map((n) => [n.address, n])), [nodes]);
  const focus = hovered ?? selected;
  const edgeW = (usdc: number) => Math.max(0.8, Math.min(4, 0.8 + Math.log10(1 + usdc) * 0.7));

  return (
    <svg
      viewBox={`0 0 ${LAYOUT_W} ${LAYOUT_H}`}
      className={styles.svg}
      role="img"
      aria-label={`Trust map: ${nodes.length} graded counterparties, ${edges.length} USDC transfers among them`}
      onClick={(e) => { if (e.target === e.currentTarget) onSelect(null); }}
    >
      <defs>
        <marker id="tm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className={styles.arrow} />
        </marker>
        <marker id="tm-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className={styles.arrowHot} />
        </marker>
      </defs>

      {layout.clusters.map((c) => (
        <g key={c.tier} className={styles[`cluster${c.tier}`]} aria-hidden="true">
          <circle cx={c.cx} cy={c.cy} r={c.radius} className={styles.clusterRing} />
          <text x={c.cx} y={c.cy - c.radius - 8} textAnchor="middle" className={styles.clusterLabel}>
            {c.tier} · {c.count}
          </text>
        </g>
      ))}

      {edges.map((e, i) => {
        const a = layout.byAddress.get(e.from), b = layout.byAddress.get(e.to);
        if (!a || !b) return null;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const ux = dx / d, uy = dy / d;
        const x1 = a.x + ux * (a.r + 2), y1 = a.y + uy * (a.r + 2);
        const x2 = b.x - ux * (b.r + 4), y2 = b.y - uy * (b.r + 4);
        const hot = focus != null && (e.from === focus || e.to === focus);
        const dim = focus != null && !hot;
        return (
          <line
            key={`${e.txHash}-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
            className={hot ? styles.edgeHot : dim ? styles.edgeDim : styles.edge}
            style={{ strokeWidth: edgeW(e.usdc) }}
            markerEnd={hot ? "url(#tm-arrow-hot)" : "url(#tm-arrow)"}
          >
            <title>{`${short(e.from)} → ${short(e.to)}: ${e.usdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC${e.source === "demo" ? " (demo)" : ""}`}</title>
          </line>
        );
      })}

      {layout.nodes.map((p) => {
        const n = byAddr.get(p.address)!;
        const isSel = selected === p.address;
        const isHov = hovered === p.address;
        const changed = n.changedAt != null && now - n.changedAt < DAY;
        const dim = focus != null && focus !== p.address && !edges.some((e) => (e.from === focus && e.to === p.address) || (e.to === focus && e.from === p.address));
        const label = p.r >= 14 || isSel || isHov;
        const tip = [
          `${n.tier} · score ${n.score}`, n.address,
          `${n.usdcIn24h.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC in (24h)`,
          `last seen block ${n.lastSeenBlock}`,
          changed ? `tier changed ${n.prevTier ?? "?"} → ${n.tier}` : null,
          n.source === "demo" ? "demo seed" : null,
        ].filter(Boolean).join("\n");
        return (
          <g
            key={p.address}
            className={`${styles.node} ${styles[`node${n.tier}`]} ${dim ? styles.nodeDim : ""} ${isSel ? styles.nodeSelected : ""}`}
            style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
            role="button" tabIndex={0}
            aria-label={`${short(n.address)} ${n.tier} score ${n.score}`}
            aria-pressed={isSel}
            onClick={(e) => { e.stopPropagation(); onSelect(isSel ? null : p.address); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(isSel ? null : p.address); } }}
            onMouseEnter={() => onHover(p.address)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(p.address)}
            onBlur={() => onHover(null)}
          >
            <title>{tip}</title>
            {changed && <circle r={p.r + 6} className={styles.pulse} />}
            <circle r={p.r} className={styles.dot} />
            {n.source === "demo" && <circle r={Math.max(2, p.r * 0.3)} className={styles.demoDot} />}
            {label && (
              <text y={p.r + 12} textAnchor="middle" className={styles.label}>
                {short(n.address, 6, 4)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
