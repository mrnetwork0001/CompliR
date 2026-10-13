import type { Metadata } from "next";
import { DocArticle } from "./_components/DocArticle";
import { entryFor, neighbours } from "./_content/registry";

const entry = entryFor("welcome")!;

export const metadata: Metadata = {
  title: { absolute: `${entry.page.title} · CompliR Docs` },
  description: entry.page.description,
};

/** /docs — the Welcome page (first entry of the registry). Keeps #quickstart and #mcp anchors. */
export default function DocsIndexPage() {
  const { prev, next } = neighbours(entry.page.slug);
  return <DocArticle entry={entry} prev={prev} next={next} />;
}
