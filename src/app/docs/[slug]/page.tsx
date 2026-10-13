import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocArticle } from "../_components/DocArticle";
import { ALL_ENTRIES, entryFor, neighbours } from "../_content/registry";

type Params = { params: Promise<{ slug: string }> };

/** Every page comes from the content registry; unknown slugs are 404. */
export const dynamicParams = false;

export function generateStaticParams(): { slug: string }[] {
  return ALL_ENTRIES.filter((e) => e.page.slug !== "welcome").map((e) => ({ slug: e.page.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const entry = entryFor(slug);
  if (!entry || slug === "welcome") return {};
  return { title: { absolute: `${entry.page.title} · CompliR Docs` }, description: entry.page.description };
}

export default async function DocPage({ params }: Params) {
  const { slug } = await params;
  const entry = entryFor(slug);
  if (!entry || slug === "welcome") notFound();
  const { prev, next } = neighbours(slug);
  return <DocArticle entry={entry} prev={prev} next={next} />;
}
