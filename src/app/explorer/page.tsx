import type { Metadata } from "next";
import { Explorer } from "@/components/Explorer";

export const metadata: Metadata = {
  title: "Explorer",
  description: "Arc Trust Explorer: screen any address, get a signed, replayable risk verdict.",
};

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** `/explorer?address=0x…` prefills the form and runs the screen immediately. */
export default async function ExplorerPage({ searchParams }: PageProps<"/explorer">) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.address) ? sp.address[0] : sp.address;
  const address = typeof raw === "string" && ADDR.test(raw.trim()) ? raw.trim() : "";
  return <Explorer initialAddress={address} autoRun={address !== ""} />;
}
