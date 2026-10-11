"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GITHUB_URL } from "./Nav";
import styles from "./Footer.module.css";

/** Slim app footer. The landing page (/) renders its own, richer footer section. */
export function Footer() {
  const pathname = usePathname() ?? "/";
  if (pathname === "/") return null;
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <p className={styles.claims}>
          <span>Never holds funds</span>
          <span className={styles.sep} aria-hidden="true" />
          <span>Signed verdicts</span>
          <span className={styles.sep} aria-hidden="true" />
          <span>Built on Arc</span>
        </p>
        <nav className={styles.links} aria-label="Footer">
          <Link href="/">About</Link>
          <Link href="/app">Console</Link>
          <Link href="/docs">Docs</Link>
          <Link href="/docs/mcp">MCP</Link>
          <a href="/api/v1/health" target="_blank" rel="noopener noreferrer">
            API status
          </a>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
