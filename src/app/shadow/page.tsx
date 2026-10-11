import type { Metadata } from "next";
import { ShadowReport } from "@/components/ShadowReport";

export const metadata: Metadata = {
  title: "Shadow Report",
  description: "Paste a payee book and recent payments; see what CompliR would have held or limited.",
};

export default function ShadowPage() {
  return <ShadowReport />;
}
