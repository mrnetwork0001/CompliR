import type { ReactNode } from "react";

/** One H2 section of a docs page. `id` is the anchor and feeds the "On this page" TOC. */
export interface DocSection {
  id: string;
  title: string;
  body: ReactNode;
}

/** A docs page. The registry (`registry.ts`) decides order, group and href. */
export interface DocPage {
  slug: string;
  title: string;
  /** <meta description> and the gallery card line. */
  description: string;
  /** Lead paragraph; the first sentence is wrapped in <strong> by the author. */
  lead: ReactNode;
  /** Optional free-form content between the lead and the first H2. */
  intro?: ReactNode;
  sections: DocSection[];
}

export type DocGroupId = "getting-started" | "oracle" | "agent" | "integrate" | "operate" | "trust";

export interface DocGroup {
  id: DocGroupId;
  label: string;
  pages: DocPage[];
}

export interface DocEntry {
  page: DocPage;
  group: DocGroup;
  href: string;
  index: number;
}
