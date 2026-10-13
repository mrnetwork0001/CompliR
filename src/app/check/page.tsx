import type { Metadata } from "next";
import { CheckForm } from "@/components/CheckForm";

export const metadata: Metadata = {
  title: "Check before you pay",
  description: "Paste an address, a payment link or an invoice PDF. CompliR grades the wallet and answers in plain English: don't pay, pay up to N, or safe to pay.",
};

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** `/check?address=0x…` prefills the Address tab. */
export default async function CheckPage({ searchParams }: PageProps<"/check">) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.address) ? sp.address[0] : sp.address;
  const address = typeof raw === "string" && ADDR.test(raw.trim()) ? raw.trim() : "";
  return <CheckForm initialAddress={address} />;
}
