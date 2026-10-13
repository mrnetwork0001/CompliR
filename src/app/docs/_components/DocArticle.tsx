import Link from "next/link";
import type { DocEntry } from "../_content/types";
import styles from "../docs.module.css";

/**
 * One docs page: kicker (group), H1, lead, optional intro, H2 sections on hairlines, prev/next pager.
 * The right-hand "On this page" TOC is built from the sections (visible ≥ 1200 px).
 */
export function DocArticle({ entry, prev, next }: { entry: DocEntry; prev: DocEntry | null; next: DocEntry | null }) {
  const { page, group } = entry;
  return (
    <div className={styles.main}>
      <article className={styles.article}>
        <p className="kicker">
          <b>{group.label}</b>
          <span aria-hidden="true">·</span>
          <span>
            {String(entry.index + 1).padStart(2, "0")}
          </span>
        </p>
        <h1 className={styles.h1}>{page.title}</h1>
        <p className={styles.lead}>{page.lead}</p>
        {page.intro && <div className={styles.intro}>{page.intro}</div>}

        {page.sections.map((s) => (
          <section key={s.id} id={s.id} className={styles.section}>
            <h2 className={styles.h2}>
              <a href={`#${s.id}`} className={styles.anchor}>
                {s.title}
              </a>
            </h2>
            {s.body}
          </section>
        ))}

        <nav className={styles.pager} aria-label="Previous and next page">
          {prev ? (
            <Link href={prev.href} className={styles.pagerLink} rel="prev">
              <span className={styles.pagerKicker}>Previous</span>
              <span className={styles.pagerTitle}>{prev.page.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={next.href} className={`${styles.pagerLink} ${styles.pagerNext}`} rel="next">
              <span className={styles.pagerKicker}>Next</span>
              <span className={styles.pagerTitle}>{next.page.title}</span>
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </article>

      <aside className={styles.toc} aria-label="On this page">
        <p className={styles.tocLabel}>On this page</p>
        <ul className={styles.tocList}>
          {page.sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`}>{s.title}</a>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
