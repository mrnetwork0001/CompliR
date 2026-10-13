/** Monochrome 20px line icons for the console. Stroke = currentColor, no fills, one weight. */
import type { ReactNode } from "react";

export type IconName =
  | "operator"
  | "payouts"
  | "report"
  | "explorer"
  | "map"
  | "shadow"
  | "badge"
  | "tips"
  | "ledger"
  | "feed"
  | "numbers"
  | "docs"
  | "sdk"
  | "mcp"
  | "api"
  | "arrow"
  | "check"
  | "alert"
  | "pulse";

const PATHS: Record<IconName, ReactNode> = {
  operator: (
    <>
      <rect x="4" y="4" width="12" height="12" rx="2" />
      <rect x="7.5" y="7.5" width="5" height="5" rx="1" />
      <path d="M10 1.5V4M10 16v2.5M1.5 10H4M16 10h2.5M6 1.5V4M14 1.5V4M6 16v2.5M14 16v2.5M1.5 6H4M1.5 14H4M16 6h2.5M16 14h2.5" />
    </>
  ),
  payouts: (
    <>
      <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
      <path d="M2.5 8.5h15" />
      <path d="M6 12.5h3" />
    </>
  ),
  report: (
    <>
      <path d="M5 2.5h6.5L15.5 6.5V17.5H5z" />
      <path d="M11.5 2.5v4h4" />
      <path d="M7.5 10.5h5M7.5 13.5h5" />
    </>
  ),
  explorer: (
    <>
      <circle cx="9" cy="9" r="5.5" />
      <path d="m13 13 4.5 4.5" />
    </>
  ),
  map: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M2.5 10h15M10 2.5c2.5 2.3 2.5 12.7 0 15M10 2.5c-2.5 2.3-2.5 12.7 0 15" />
    </>
  ),
  shadow: (
    <>
      <path d="m10 3 7 4-7 4-7-4z" />
      <path d="m3 11 7 4 7-4" />
      <path d="m3 14.5 7 4 7-4" />
    </>
  ),
  badge: (
    <>
      <circle cx="10" cy="8" r="5" />
      <path d="m7 12.5-1.5 5 4.5-2 4.5 2-1.5-5" />
    </>
  ),
  tips: (
    <>
      <path d="M3.5 8.5v3L12 15V5z" />
      <path d="M12 7.5a2.5 2.5 0 0 1 0 5M5.5 11.5l1 5" />
    </>
  ),
  ledger: (
    <>
      <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-1 1" />
      <path d="M11.5 8.5a3 3 0 0 0-4.2 0L5 10.8a3 3 0 0 0 4.2 4.2l1-1" />
    </>
  ),
  feed: <path d="M2.5 10h3l2-5 3 10 2-7 1.5 2h3.5" />,
  numbers: <path d="M4 16V9M10 16V4M16 16v-5" />,
  docs: (
    <>
      <path d="M3.5 4.5a2 2 0 0 1 2-2H10v14H5.5a2 2 0 0 0-2 2z" />
      <path d="M16.5 4.5a2 2 0 0 0-2-2H10v14h4.5a2 2 0 0 1 2 2z" />
    </>
  ),
  sdk: (
    <>
      <path d="m6.5 6-4 4 4 4M13.5 6l4 4-4 4" />
      <path d="m11.5 3.5-3 13" />
    </>
  ),
  mcp: (
    <>
      <path d="M7 2.5v4M13 2.5v4" />
      <path d="M4.5 6.5h11v3a5.5 5.5 0 0 1-11 0z" />
      <path d="M10 15v2.5" />
    </>
  ),
  api: <path d="M2.5 10h3.5l2-5 3 10 2-5h4.5" />,
  arrow: <path d="M4 10h12m-5-5 5 5-5 5" />,
  check: <path d="m4 10.5 4 4 8-9" />,
  alert: (
    <>
      <path d="M10 3 2.5 16.5h15z" />
      <path d="M10 8v4M10 14.5v.5" />
    </>
  ),
  pulse: <path d="M2.5 10h3l2-4 3 8 2-6 1.5 2h3.5" />,
};

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
