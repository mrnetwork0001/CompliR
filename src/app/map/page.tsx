import type { Metadata } from "next";
import { TrustMap } from "./_components/TrustMap";

export const metadata: Metadata = {
  title: "Arc Trust Map",
  description: "Live, chain-wide counterparty risk map of Arc mainnet: who is receiving USDC right now, graded by CompliR.",
};

export default function MapPage() {
  return <TrustMap />;
}
