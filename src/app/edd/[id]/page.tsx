import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getEddRequest, toPublicView } from "@/lib/edd";
import { EddForm } from "./EddForm";
import styles from "./page.module.css";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Due diligence ${id}`, robots: { index: false, follow: false } };
}

export default async function EddPage({ params }: Props) {
  const { id } = await params;
  if (!/^edd_[0-9a-f]{8,64}$/.test(id)) notFound();
  const r = await getEddRequest(id);
  if (!r) notFound();
  const view = toPublicView(r);
  return (
    <div className={`container ${styles.wrap}`}>
      <header className={styles.head}>
        <p className={`small muted ${styles.kicker}`}>CompliR · Enhanced Due Diligence</p>
        <h1 className={styles.title}>
          CompliR has a question before a payment to <code className="break">{view.subjectMasked}</code> can proceed
        </h1>
        <p className="muted">
          A business that uses CompliR asked us to screen this address before paying it. Our review raised the questions
          below. Your answers go only to the compliance reviewer; the public decision log records just a hash of them.
        </p>
      </header>
      <EddForm initial={view} />
      <p className={`small muted ${styles.foot}`}>
        Request <code>{view.id}</code> · opened {new Date(view.createdAt).toLocaleString()} · decision{" "}
        <a href={`/log/${view.decisionId}`}>{view.decisionId}</a>
      </p>
    </div>
  );
}
