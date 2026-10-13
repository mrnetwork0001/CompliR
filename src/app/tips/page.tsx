import type { Metadata } from "next";
import { TipMarket } from "./_components/TipMarket";

export const metadata: Metadata = {
  title: "Tip Market — earn USDC for risk intelligence",
  description: "Submit evidence that an address is risky, stake 0.05 USDC via x402, get paid per verified tip. Bad tips lose the stake. Verified tips feed the CompliR oracle.",
};

export default function TipsPage() {
  return <TipMarket />;
}
