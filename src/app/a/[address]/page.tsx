import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AddressPage } from "@/components/AddressPage";
import { addressHistory } from "@/lib/check/history";
import { config } from "@/lib/config";
import type { Address } from "@/lib/types";

export const dynamic = "force-dynamic";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
type Props = { params: Promise<{ address: string }> };

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  if (!ADDR.test(address)) return { title: "Address" };
  const a = address.toLowerCase() as Address;
  const h = await addressHistory(a, { limit: 1 }).catch(() => null);
  const headline = h?.latest?.headline ?? "Not graded yet";
  const title = `${headline} · ${shortAddr(a)}`;
  const description = h?.latest
    ? `CompliR verdict for ${a}: ${h.latest.tier} (score ${h.latest.score}), ${h.counts.verdicts} verdict${h.counts.verdicts === 1 ? "" : "s"} on record. Signed EIP-712, mirrored on Arc.`
    : `CompliR has not graded ${a} yet. Check it in one call: sanctions, Circle blocklist, two hops of funders.`;
  return { title, description, openGraph: { title: `${headline} · ${shortAddr(a)} · CompliR`, description }, alternates: { canonical: `/a/${a}` } };
}

/** Public, shareable risk page: plain-language verdict + the full history of verdicts for one address. */
export default async function AddressRiskPage({ params }: Props) {
  const { address } = await params;
  if (!ADDR.test(address)) notFound();
  const a = address.toLowerCase() as Address;
  const [history, cfg] = await Promise.all([addressHistory(a), Promise.resolve(config())]);
  const shareUrl = `${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/a/${a}`;
  return <AddressPage history={history} explorerUrl={cfg.ARC_EXPLORER_URL} shareUrl={shareUrl} />;
}
