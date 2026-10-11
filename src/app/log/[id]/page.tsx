import type { Metadata } from "next";
import { DecisionReplay } from "@/components/DecisionReplay";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Decision ${id}` };
}

export default async function LogPage({ params }: Props) {
  const { id } = await params;
  return <DecisionReplay id={id} />;
}
