import type { Metadata } from "next";
import { FeedTable } from "@/components/FeedTable";

export const metadata: Metadata = { title: "Live feed" };

export default function FeedPage() {
  return <FeedTable limit={20} />;
}
