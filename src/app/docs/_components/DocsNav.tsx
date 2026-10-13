"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import styles from "../docs.module.css";

export interface NavGroupData {
  id: string;
  label: string;
  items: { href: string; title: string }[];
}

/**
 * Docs sidebar. ≥ 900 px: grouped link list with mono group labels and an accent bar on the active page.
 * < 900 px: the same structure as a <select> (CSS swaps which one is visible).
 */
export function DocsNav({ groups }: { groups: NavGroupData[] }) {
  const pathname = usePathname() ?? "/docs";
  const router = useRouter();
  const current = groups.flatMap((g) => g.items).find((i) => i.href === pathname)?.href ?? "/docs";

  return (
    <nav className={styles.sidebarNav} aria-label="Documentation">
      <div className={styles.desktopNav}>
        {groups.map((g) => (
          <section key={g.id} className={styles.group} aria-labelledby={`docs-group-${g.id}`}>
            <h2 id={`docs-group-${g.id}`} className={styles.groupLabel}>
              {g.label}
            </h2>
            <ul className={styles.items}>
              {g.items.map((it) => {
                const active = it.href === pathname;
                return (
                  <li key={it.href}>
                    <Link href={it.href} className={`${styles.item} ${active ? styles.itemActive : ""}`} aria-current={active ? "page" : undefined}>
                      {it.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <label className={styles.mobileNav}>
        <span className={styles.mobileLabel}>Docs</span>
        <select className={`input ${styles.select}`} value={current} onChange={(e) => router.push(e.target.value)} aria-label="Documentation page">
          {groups.map((g) => (
            <optgroup key={g.id} label={g.label}>
              {g.items.map((it) => (
                <option key={it.href} value={it.href}>
                  {it.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
    </nav>
  );
}
