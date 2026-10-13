import type { Metadata } from "next";
import { PayMerchant } from "./_components/PayMerchant";

export const metadata: Metadata = {
  title: "Payment links - screen the payer before you accept",
  description: "Create a USDC payment link on Arc. CompliR screens the wallet the payer sends from; HIGH-risk wallets are declined before funds move.",
};

export default function PayPage() {
  return <PayMerchant />;
}
