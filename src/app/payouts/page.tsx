import type { Metadata } from "next";
import { PayoutsDashboard } from "./_components/PayoutsDashboard";

export const metadata: Metadata = {
  title: "Guarded Payouts",
  description: "A treasury agent that pays contractors on Arc but cannot pay a tainted address: every payout goes through CompliR.",
};

export default function PayoutsPage() {
  return <PayoutsDashboard />;
}
