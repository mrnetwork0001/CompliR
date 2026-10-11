import type { Metadata } from "next";
import { LedgerList } from "@/components/LedgerList";

export const metadata: Metadata = { title: "Decision ledger" };

export default function LedgerPage() {
  return <LedgerList limit={50} />;
}
