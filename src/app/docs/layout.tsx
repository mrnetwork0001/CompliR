import Link from "next/link";
import { DocsNav } from "./_components/DocsNav";
import { DOC_GROUPS, hrefFor } from "./_content/registry";
import styles from "./docs.module.css";

/** Two-column docs shell: sticky grouped sidebar (collapses to a select under 900 px) + the page. */
export default function DocsLayout({ children }: LayoutProps<"/docs">) {
  const groups = DOC_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    items: g.pages.map((p) => ({ href: hrefFor(p.slug), title: p.title })),
  }));
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHead}>
          <Link href="/docs" className={styles.sidebarTitle}>
            CompliR Docs
          </Link>
          <span className={styles.sidebarMeta}>API v1 · Arc 5042</span>
        </div>
        <DocsNav groups={groups} />
      </aside>
      {children}
    </div>
  );
}
