/** Telegram bot server side: webhook event schema + message formatting (route: src/app/api/v1/bot/webhook). */
import { z } from "zod";

export const BotEventSchema = z.object({
  type: z.string(),
  address: z.string(),
  from: z.string().nullable().optional(),
  to: z.string(),
  verdict: z.object({ score: z.number().optional(), rationale: z.string().optional(), decisionId: z.string().optional() }).passthrough().optional(),
  registryTx: z.string().nullable().optional(),
}).passthrough();
export type BotEvent = z.infer<typeof BotEventSchema>;

export function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function formatTierMessage(e: BotEvent, base: string): string {
  const v = e.verdict ?? {};
  const lines = [
    `CompliR watch: ${e.address}`,
    `Tier ${e.from ?? "UNKNOWN"} → ${e.to}${typeof v.score === "number" ? ` (score ${v.score})` : ""}`,
  ];
  if (v.rationale) lines.push(v.rationale);
  if (v.decisionId) lines.push(`Decision: ${base}/log/${v.decisionId}`);
  lines.push(`Details: ${base}/a/${e.address}`);
  return lines.join("\n");
}
