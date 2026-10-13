import type { Metadata } from "next";
import { Console } from "./_components/Console";

export const metadata: Metadata = {
  title: "Console",
  description: "CompliR operations console: the agent's latest decision, live risk map, treasury, ledger and every surface in one view.",
};

export default function AppPage() {
  return <Console />;
}
