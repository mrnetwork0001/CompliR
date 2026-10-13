/**
 * POST /api/v1/bot/webhook?chat=<telegram chat id>&secret=<BOT_WEBHOOK_SECRET>
 * Webhook target for watches registered by the Telegram bot (packages/bot). Verifies the shared secret, then forwards a
 * `tier.changed` event to the chat via the Telegram Bot API (TELEGRAM_BOT_TOKEN). Without a token the event is logged only.
 * Env: BOT_WEBHOOK_SECRET (required to enable), TELEGRAM_BOT_TOKEN, PUBLIC_BASE_URL.
 */
import { config } from "@/lib/config";
import { BotEventSchema, formatTierMessage, timingSafeEq } from "@/lib/bot";
import { ApiError, handle, ok } from "../../../_lib/respond";
import { parseJson } from "../../../_lib/parse";

export const POST = handle(async (req) => {
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) throw new ApiError("NOT_FOUND", "Bot webhook is not enabled (BOT_WEBHOOK_SECRET unset).");
  const url = new URL(req.url);
  if (!timingSafeEq(url.searchParams.get("secret") ?? "", secret)) throw new ApiError("FORBIDDEN", "Bad webhook secret.");
  const chat = url.searchParams.get("chat");
  if (!chat || !/^-?\d{1,20}$/.test(chat)) throw new ApiError("VALIDATION_ERROR", "chat must be a Telegram chat id.");

  const evt = await parseJson(req, BotEventSchema);
  if (evt.type !== "tier.changed") return ok({ ok: true, ignored: evt.type });
  const text = formatTierMessage(evt, config().PUBLIC_BASE_URL.replace(/\/$/, ""));

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.warn("[bot/webhook] TELEGRAM_BOT_TOKEN unset; would send to", chat, text); return ok({ ok: true, delivered: false, reason: "no token" }); }
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000),
  }).catch((e: Error) => { throw new ApiError("INTERNAL_ERROR", `Telegram unreachable: ${e.message}`); });
  if (!r.ok) throw new ApiError("INTERNAL_ERROR", `Telegram API ${r.status}`);
  return ok({ ok: true, delivered: true });
});
