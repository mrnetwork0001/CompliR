import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PayLinkView } from "../_components/PayLinkView";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export async function generateMetadata({ params }: PageProps<"/pay/[id]">): Promise<Metadata> {
  const { id } = await params;
  return { title: `Payment request ${id}`, robots: { index: false, follow: false } };
}

export default async function PayLinkPage({ params, searchParams }: PageProps<"/pay/[id]">) {
  const { id } = await params;
  if (!/^pay_[0-9a-f]{12}$/.test(id)) notFound();
  const sp = await searchParams;
  const from = one(sp.from).trim();
  return <PayLinkView id={id} from={ADDR.test(from) ? from.toLowerCase() : ""} merchantKey={one(sp.key).trim()} />;
}
