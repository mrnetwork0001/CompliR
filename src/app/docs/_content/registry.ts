/**
 * Docs content registry: sidebar groups, page order, hrefs. Pages live in this folder, one module each.
 * `/docs` renders the first page (welcome); `/docs/<slug>` renders the rest.
 */
import type { DocEntry, DocGroup } from "./types";
import { welcome } from "./welcome";
import { howItWorks } from "./how-it-works";
import { screening } from "./screening";
import { reasonCodes } from "./reason-codes";
import { attestations } from "./attestations";
import { rescreening } from "./rescreening";
import { shadowBadge } from "./shadow-badge";
import { checkPages } from "./check-pages";
import { operator } from "./operator";
import { guardedPayouts } from "./guarded-payouts";
import { riskAnalyst } from "./risk-analyst";
import { tipMarket } from "./tip-market";
import { refundsReport } from "./refunds-report";
import { httpApi } from "./http-api";
import { sdk } from "./sdk";
import { mcp } from "./mcp";
import { solidity } from "./solidity";
import { x402 } from "./x402";
import { selfHosting } from "./self-hosting";
import { mainnetChecklist } from "./mainnet-checklist";
import { trustModel } from "./trust-model";
import { ledgerReports } from "./ledger-reports";

export const DOC_GROUPS: DocGroup[] = [
  { id: "getting-started", label: "Getting started", pages: [welcome, howItWorks] },
  { id: "oracle", label: "Oracle", pages: [screening, checkPages, reasonCodes, attestations, rescreening, shadowBadge] },
  { id: "agent", label: "The agent", pages: [operator, guardedPayouts, riskAnalyst, tipMarket, refundsReport] },
  { id: "integrate", label: "Integrate", pages: [httpApi, sdk, mcp, solidity, x402] },
  { id: "operate", label: "Operate", pages: [selfHosting, mainnetChecklist] },
  { id: "trust", label: "Trust", pages: [trustModel, ledgerReports] },
];

export function hrefFor(slug: string): string {
  return slug === "welcome" ? "/docs" : `/docs/${slug}`;
}

export const ALL_ENTRIES: DocEntry[] = DOC_GROUPS.flatMap((group) => group.pages.map((page) => ({ page, group, href: hrefFor(page.slug), index: 0 }))).map((e, index) => ({ ...e, index }));

export function entryFor(slug: string): DocEntry | null {
  return ALL_ENTRIES.find((e) => e.page.slug === slug) ?? null;
}

export function neighbours(slug: string): { prev: DocEntry | null; next: DocEntry | null } {
  const i = ALL_ENTRIES.findIndex((e) => e.page.slug === slug);
  if (i < 0) return { prev: null, next: null };
  return { prev: ALL_ENTRIES[i - 1] ?? null, next: ALL_ENTRIES[i + 1] ?? null };
}
