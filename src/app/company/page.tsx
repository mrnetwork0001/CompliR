import type { Metadata } from "next";
import { CompanyDashboard } from "./_components/CompanyDashboard";

export const metadata: Metadata = {
  title: "Company",
  description: "CompliR is run by an agent. Revenue, reserves, obligations, pricing and every operator decision, signed into a hash-chained ledger.",
};

export default function CompanyPage() {
  return <CompanyDashboard />;
}
