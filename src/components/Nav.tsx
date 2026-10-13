"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { HealthResponse } from "@/app/api/_lib/public-types";
import { getHealth } from "./api";
import { ThemeToggle } from "./ThemeToggle";
import styles from "./Nav.module.css";

/** Placeholder until the repository is public. */
export const GITHUB_URL = "https://github.com/mrnetwork0001/complir";

/* ─── Information architecture ──────────────────────────────────────────────
 * CompliR is one company run by an agent. The nav mirrors that: the company (its decisions and books),
 * the oracle (its product), the records (its signed history), and the docs (how to plug in).
 */
export interface NavItem {
  href: string;
  label: string;
  hint: string;
  /** opens in a new tab (raw API) */
  external?: boolean;
  /** custom active matcher; default = exact or prefix match on the hash-less href */
  match?: (pathname: string) => boolean;
}
export interface NavGroup {
  id: "company" | "oracle" | "records" | "docs";
  label: string;
  blurb: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "company",
    label: "Company",
    blurb: "An agent runs the company. These are its decisions and its books.",
    items: [
      { href: "/company", label: "Operator", hint: "Today's decision, reserves, obligations, pricing" },
      { href: "/payouts", label: "Guarded Payouts", hint: "Treasury paying through GuardedTreasury" },
      { href: "/report", label: "Daily report", hint: "Signed traction report, one per UTC day" },
    ],
  },
  {
    id: "oracle",
    label: "Oracle",
    blurb: "The product: counterparty risk on Arc, graded and signed.",
    items: [
      { href: "/check", label: "Check", hint: "Check before you pay: address, link or invoice", match: (p) => p === "/check" || p.startsWith("/check/") || p.startsWith("/a/") },
      { href: "/map", label: "Trust Map", hint: "Arc mainnet, graded as it moves" },
      { href: "/shadow", label: "Shadow report", hint: "What we would have held in your payee book" },
      { href: "/badge", label: "Badge", hint: "Screened-by-CompliR SVG and embed" },
      { href: "/tips", label: "Tips", hint: "Staked community intelligence" },
    ],
  },
  {
    id: "records",
    label: "Records",
    blurb: "Everything the agent does, hash-chained and replayable.",
    items: [
      { href: "/ledger", label: "Ledger", hint: "Hash-chained decision log", match: (p) => p.startsWith("/ledger") || p.startsWith("/log") },
      { href: "/feed", label: "Feed", hint: "Recent screenings, addresses masked" },
      { href: "/numbers", label: "Numbers", hint: "Honest public counters" },
    ],
  },
];

function itemActive(item: NavItem, pathname: string): boolean {
  if (item.match) return item.match(pathname);
  if (item.href.includes("#") || item.external) return false;
  return pathname === item.href || pathname.startsWith(item.href + "/");
}
function groupActive(group: NavGroup, pathname: string): boolean {
  return group.items.some((i) => itemActive(i, pathname));
}

/* ─── Pieces ──────────────────────────────────────────────────────────────── */

function Brand({ href }: { href: string }) {
  return (
    <Link href={href} className={styles.brand} aria-label="CompliR home">
      <span className={styles.mark} aria-hidden="true">
        <i /><i /><i /><i />
      </span>
      <span className={styles.name}>CompliR</span>
    </Link>
  );
}

function Chevron() {
  return (
    <svg className={styles.chev} viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

/** Status chip: network · signer mode · x402, from /api/v1/health. Never blocks render. Not rendered in the header any more (the /app status bar carries it); kept as an export. */
export function StatusChip({ compact = false }: { compact?: boolean }) {
  const [h, setH] = useState<HealthResponse | null>(null);
  useEffect(() => {
    let alive = true;
    getHealth().then((r) => alive && setH(r));
    return () => {
      alive = false;
    };
  }, []);
  const state = !h ? "unknown" : h.paused ? "paused" : h.ok ? "ok" : "degraded";
  const label = !h ? "Checking…" : h.paused ? "Paused" : h.ok ? "Operational" : "Degraded";
  const chain = h?.chainId ? `Arc ${h.chainId}` : "Arc";
  const signer = h?.signer?.mode ?? "-";
  const x402 = h ? (h.x402.disabled ? "x402 off" : "x402 on") : "x402 -";
  return (
    <a
      href="/api/v1/health"
      target="_blank"
      rel="noopener noreferrer"
      className={`${styles.chip} ${compact ? styles.chipCompact : ""}`}
      data-state={state}
      title={`${label} · ${chain} · signer ${signer} · ${x402}${h?.error ? ` · ${h.error}` : ""}`}
      aria-label={`API status: ${label}, ${chain}, signer ${signer}, ${x402}`}
    >
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.chipText}>{chain}</span>
      <span className={styles.chipMore}>
        <span className={styles.chipSep} aria-hidden="true" />
        <span className={styles.chipText}>{signer}</span>
        <span className={styles.chipSep} aria-hidden="true" />
        <span className={styles.chipText}>{x402}</span>
      </span>
    </a>
  );
}

/** One desktop group: trigger button + dropdown panel. Keyboard: Enter/Space/ArrowDown open, arrows move, Escape closes. */
function GroupMenu({
  group,
  pathname,
  open,
  onOpen,
  onClose,
  onToggle,
}: {
  group: NavGroup;
  pathname: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onToggle: () => void;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** which item to focus once the panel is open (set by the trigger's keyboard handler) */
  const pendingFocus = useRef<null | "first" | "last">(null);
  const active = groupActive(group, pathname);

  const focusItem = (which: "first" | "last") => {
    const links = panelRef.current?.querySelectorAll<HTMLAnchorElement>("a[role=menuitem]");
    if (links && links.length) (which === "first" ? links[0] : links[links.length - 1]).focus();
  };
  // The panel is `hidden` until `open` flips, so a focus requested from the trigger lands after that render.
  useEffect(() => {
    if (!open || !pendingFocus.current) return;
    focusItem(pendingFocus.current);
    pendingFocus.current = null;
  }, [open]);

  const openAndFocus = (which: "first" | "last") => {
    if (open) focusItem(which);
    else {
      pendingFocus.current = which;
      onOpen();
    }
  };
  const onTriggerKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openAndFocus("first");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openAndFocus("last");
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      onClose();
    }
  };
  const onPanelKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const links = Array.from(panelRef.current?.querySelectorAll<HTMLAnchorElement>("a[role=menuitem]") ?? []);
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      links[(i + 1) % links.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      links[(i - 1 + links.length) % links.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      links[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      links[links.length - 1]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      triggerRef.current?.focus();
    } else if (e.key === "Tab") {
      onClose();
    }
  };

  return (
    <div className={styles.group} onMouseEnter={onOpen} onMouseLeave={onClose} data-open={open || undefined}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${active ? styles.triggerActive : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        aria-current={active ? "true" : undefined}
        onClick={onToggle}
        onKeyDown={onTriggerKey}
      >
        {group.label}
        <Chevron />
      </button>
      <div
        ref={panelRef}
        id={`${id}-menu`}
        role="menu"
        aria-label={group.label}
        className={styles.panel}
        hidden={!open}
        onKeyDown={onPanelKey}
      >
        <p className={styles.blurb}>{group.blurb}</p>
        <ul className={styles.items}>
          {group.items.map((it) => {
            const current = itemActive(it, pathname);
            const inner = (
              <>
                <span className={styles.itemLabel}>{it.label}</span>
                <span className={styles.itemHint}>{it.hint}</span>
              </>
            );
            return (
              <li key={it.href} role="none">
                {it.external ? (
                  <a href={it.href} role="menuitem" className={styles.item} target="_blank" rel="noopener noreferrer" onClick={onClose}>
                    {inner}
                  </a>
                ) : (
                  <Link href={it.href} role="menuitem" className={styles.item} aria-current={current ? "page" : undefined} onClick={onClose}>
                    {inner}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** Phone slide-over with the same groups as an accordion. */
function Sheet({ pathname, onClose, returnTo }: { pathname: string; onClose: () => void; returnTo: React.RefObject<HTMLButtonElement | null> }) {
  const initial = NAV_GROUPS.find((g) => groupActive(g, pathname))?.id ?? "company";
  const [expanded, setExpanded] = useState<NavGroup["id"] | null>(initial);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const back = returnTo.current;
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
      back?.focus();
    };
  }, [onClose, returnTo]);

  return (
    <div className={styles.sheetRoot}>
      <button type="button" className={styles.backdrop} aria-label="Close menu" onClick={onClose} tabIndex={-1} />
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="Navigation">
        <div className={styles.sheetHead}>
          <span className={styles.sheetTools}>
            <ThemeToggle />
            <button ref={closeRef} type="button" className={styles.close} onClick={onClose} aria-label="Close menu">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M3 3l10 10M13 3 3 13" />
            </svg>
          </button>
          </span>
        </div>
        <Link href="/app" className={`${styles.sheetLink} ${pathname === "/app" ? styles.sheetLinkActive : ""}`} aria-current={pathname === "/app" ? "page" : undefined} onClick={onClose}>
          Console
        </Link>
        {NAV_GROUPS.map((g) => {
          const isOpen = expanded === g.id;
          const active = groupActive(g, pathname);
          return (
            <section key={g.id} className={styles.acc}>
              <button
                type="button"
                className={`${styles.accHead} ${active ? styles.accActive : ""}`}
                aria-expanded={isOpen}
                aria-controls={`sheet-${g.id}`}
                onClick={() => setExpanded(isOpen ? null : g.id)}
              >
                <span>{g.label}</span>
                <Chevron />
              </button>
              <ul id={`sheet-${g.id}`} className={styles.accList} hidden={!isOpen}>
                {g.items.map((it) => {
                  const current = itemActive(it, pathname);
                  return (
                    <li key={it.href}>
                      {it.external ? (
                        <a href={it.href} className={styles.accItem} target="_blank" rel="noopener noreferrer" onClick={onClose}>
                          <span className={styles.itemLabel}>{it.label}</span>
                          <span className={styles.itemHint}>{it.hint}</span>
                        </a>
                      ) : (
                        <Link href={it.href} className={styles.accItem} aria-current={current ? "page" : undefined} onClick={onClose}>
                          <span className={styles.itemLabel}>{it.label}</span>
                          <span className={styles.itemHint}>{it.hint}</span>
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        <div className={styles.sheetFoot}>
          <Link href="/" onClick={onClose}>About CompliR</Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>
      </div>
    </div>
  );
}

/* ─── Nav ─────────────────────────────────────────────────────────────────── */

export function Nav() {
  const pathname = usePathname() ?? "/";
  const [openId, setOpenId] = useState<NavGroup["id"] | null>(null);
  const [sheet, setSheet] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const openGroup = useCallback((id: NavGroup["id"]) => {
    clearTimer();
    setOpenId(id);
  }, []);
  const closeGroup = useCallback(() => {
    clearTimer();
    closeTimer.current = setTimeout(() => setOpenId(null), 120);
  }, []);
  const closeSheet = useCallback(() => setSheet(false), []);

  // Click outside or Escape (wherever focus is) closes an open dropdown.
  useEffect(() => {
    if (!openId) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openId]);

  if (pathname === "/") {
    return (
      <header className={styles.header}>
        <div className={styles.inner}>
          <Brand href="/" />
          <nav className={styles.landingNav} aria-label="Primary">
            <Link href="/check" className={styles.link}>Check an address</Link>
            <Link href="/docs" className={styles.link}>Docs</Link>
            <ThemeToggle className={styles.theme} />
          </nav>
        </div>
      </header>
    );
  }

  const onApp = pathname === "/app";

  return (
    <header className={styles.header} ref={rootRef}>
      <div className={styles.inner}>
        <Brand href="/" />
        <nav className={styles.nav} aria-label="Primary">
          <Link href="/app" className={`${styles.trigger} ${onApp ? styles.triggerActive : ""}`} aria-current={onApp ? "page" : undefined} onClick={() => setOpenId(null)}>
            Console
          </Link>
          {NAV_GROUPS.map((g) => (
            <GroupMenu
              key={g.id}
              group={g}
              pathname={pathname}
              open={openId === g.id}
              onOpen={() => openGroup(g.id)}
              onClose={closeGroup}
              onToggle={() => {
                clearTimer();
                setOpenId((cur) => (cur === g.id ? null : g.id));
              }}
            />
          ))}
        </nav>
        <div className={styles.right}>
          <ThemeToggle className={styles.theme} />
          <button
            ref={burgerRef}
            type="button"
            className={styles.burger}
            aria-label="Open menu"
            aria-haspopup="dialog"
            aria-expanded={sheet}
            onClick={() => setSheet(true)}
          >
            <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" />
            </svg>
          </button>
        </div>
      </div>
      {sheet && <Sheet pathname={pathname} onClose={closeSheet} returnTo={burgerRef} />}
    </header>
  );
}
