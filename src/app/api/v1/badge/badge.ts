/**
 * "Screened by CompliR" SVG badge. Pure function so it is unit-testable; the route only adds I/O.
 * Grey "unknown" when there is no attestation; grey "expired" when the latest one is past validUntil.
 */
import type { Tier } from "@/lib/types";

export type BadgeStatus = Tier | "UNKNOWN" | "EXPIRED";

export interface BadgeInput {
  status: BadgeStatus;
  /** unix seconds; omitted for UNKNOWN */
  validUntil?: number | null;
  score?: number | null;
}

const COLOR: Record<BadgeStatus, string> = {
  LOW: "#15803d",
  MEDIUM: "#b45309",
  HIGH: "#b91c1c",
  UNKNOWN: "#6b7280",
  EXPIRED: "#6b7280",
};

export function fmtBadgeDate(unix: number): string {
  const d = new Date(unix * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Rough text width for Verdana/DejaVu at 11px, like shields.io. */
function textWidth(s: string): number {
  return Math.round([...s].reduce((w, ch) => w + (/[A-Z0-9]/.test(ch) ? 7.3 : /[a-z]/.test(ch) ? 6.3 : /[ .:·]/.test(ch) ? 3.6 : 6.5), 0));
}

export function badgeLabel(input: BadgeInput): string {
  switch (input.status) {
    case "UNKNOWN":
      return "unknown · not screened";
    case "EXPIRED":
      return `expired ${input.validUntil ? fmtBadgeDate(input.validUntil) : ""}`.trim();
    default:
      return `${input.status}${input.validUntil ? ` · valid until ${fmtBadgeDate(input.validUntil)}` : ""}`;
  }
}

export function renderBadge(input: BadgeInput): string {
  const left = "Screened by CompliR";
  const right = badgeLabel(input);
  const lw = textWidth(left) + 20;
  const rw = textWidth(right) + 20;
  const w = lw + rw;
  const h = 20;
  const color = COLOR[input.status];
  const title = `Screened by CompliR: ${right}${typeof input.score === "number" ? ` (score ${input.score})` : ""}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" role="img" aria-label="${esc(title)}">
  <title>${esc(title)}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="${h}" rx="4" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="${h}" fill="#1f2937"/>
    <rect x="${lw}" width="${rw}" height="${h}" fill="${color}"/>
    <rect width="${w}" height="${h}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <path d="M9 4.5 4.5 6.5v3.2c0 2.6 1.9 4.9 4.5 5.6 2.6-.7 4.5-3 4.5-5.6V6.5L9 4.5Z" fill="none" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/>
    <text x="${Math.round((lw + 10) / 2)}" y="15" fill="#010101" fill-opacity=".3">${esc(left)}</text>
    <text x="${Math.round((lw + 10) / 2)}" y="14">${esc(left)}</text>
    <text x="${lw + Math.round(rw / 2)}" y="15" fill="#010101" fill-opacity=".3">${esc(right)}</text>
    <text x="${lw + Math.round(rw / 2)}" y="14">${esc(right)}</text>
  </g>
</svg>`;
}
