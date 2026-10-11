import type { Metadata } from "next";
import { BadgeBuilder } from "@/components/BadgeBuilder";

export const metadata: Metadata = {
  title: "Badge",
  description: "Screened-by-CompliR SVG badge with embed snippets, linked to the live attestation.",
};

export default function BadgePage() {
  return <BadgeBuilder />;
}
