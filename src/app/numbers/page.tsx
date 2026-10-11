import type { Metadata } from "next";
import { Numbers } from "@/components/Numbers";

export const metadata: Metadata = { title: "Numbers" };

export default function NumbersPage() {
  return <Numbers />;
}
