import { permanentRedirect } from "next/navigation";

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** The Explorer folded into the consumer face: `/explorer` → `/check`, `/explorer?address=0x…` → `/a/0x…`. */
export default async function ExplorerPage({ searchParams }: PageProps<"/explorer">) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.address) ? sp.address[0] : sp.address;
  const address = typeof raw === "string" && ADDR.test(raw.trim()) ? raw.trim().toLowerCase() : "";
  permanentRedirect(address ? `/a/${address}` : "/check");
}
