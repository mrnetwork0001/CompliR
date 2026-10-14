#!/usr/bin/env node
/**
 * CompliR Telegram bot - dependency-free long polling.
 *   TELEGRAM_BOT_TOKEN=… COMPLIR_URL=https://trycomplir.xyz BOT_WEBHOOK_SECRET=… node packages/bot/bot.mjs
 *
 * Env
 *   TELEGRAM_BOT_TOKEN          from @BotFather. Missing → prints usage and exits (dry mode).
 *   COMPLIR_URL                 CompliR host (default http://localhost:3000)
 *   BOT_WEBHOOK_SECRET          shared with the server (same env there); /watch webhooks carry it
 *   COMPLIR_PAYER_PRIVATE_KEY   optional. With it, /check runs a fresh paid screen and /watch pays via x402 using
 *                               packages/sdk (needs viem from the repo root). Without it: free endpoints only
 *                               (POST /api/v1/check, falling back to GET /api/v1/attestation/<addr>; /watch needs X402_DISABLED).
 *
 * Offline check of one command (no Telegram):  node packages/bot/bot.mjs "/check 0x…"
 */
import { parseCommand, usage, formatVerdict, formatWatch, formatReport, formatError } from "./commands.mjs";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE = (process.env.COMPLIR_URL || "http://localhost:3000").replace(/\/+$/, "");
const SECRET = process.env.BOT_WEBHOOK_SECRET || "";
const PAYER_KEY = process.env.COMPLIR_PAYER_PRIVATE_KEY || "";
const TG = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

class HttpError extends Error { constructor(status, message, body) { super(message); this.status = status; this.body = body; } }

async function api(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { Accept: "application/json", "User-Agent": "complir-bot/0.1", ...(init.headers || {}) }, signal: AbortSignal.timeout(150000) /* a fresh 2-hop screen can take ~60 s */ });
  let body = null;
  try { body = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new HttpError(r.status, body?.error?.message || `HTTP ${r.status}`, body);
  return body;
}

// ── optional paid client via the SDK (Node ≥22.18 strips TS types natively) ──
let sdkClient = null, sdkTried = false;
async function paidClient() {
  if (sdkTried) return sdkClient;
  sdkTried = true;
  if (!PAYER_KEY) return null;
  try {
    const [{ CompliR }, { privateKeyToAccount }] = await Promise.all([import("../sdk/src/index.ts"), import("viem/accounts")]);
    sdkClient = new CompliR({ baseUrl: BASE, account: privateKeyToAccount(PAYER_KEY), maxPriceUsdc: 0.1 });
    console.log("[bot] paid screens enabled via SDK");
  } catch (e) {
    console.warn("[bot] SDK unavailable, using free endpoints:", e.message);
  }
  return sdkClient;
}

async function check(address) {
  const paid = await paidClient();
  if (paid) return formatVerdict(await paid.screen(address, { clientId: "telegram-bot" }), BASE);
  try {
    const v = await api("/api/v1/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, source: "address" }) });
    return formatVerdict(v, BASE);
  } catch (e) {
    if (!(e instanceof HttpError) || (e.status !== 404 && e.status !== 405)) throw e;
    const a = await api(`/api/v1/attestation/${address}`);
    return formatVerdict(a, BASE, "(via the public attestation endpoint: latest stored verdict)");
  }
}

async function watch(address, chatId) {
  const webhookUrl = `${BASE}/api/v1/bot/webhook?chat=${encodeURIComponent(chatId)}&secret=${encodeURIComponent(SECRET)}`;
  const paid = await paidClient();
  const w = paid
    ? await paid.watch(address, { webhookUrl, clientId: "telegram-bot" })
    : await api("/api/v1/watch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, webhookUrl, clientId: "telegram-bot" }) });
  return formatWatch(w, BASE) + (SECRET ? "" : "\n(BOT_WEBHOOK_SECRET is unset: the server will reject the webhook until it is set on both sides.)");
}

async function report() { return formatReport(await api("/api/v1/report"), BASE); }

export async function reply(text, chatId) {
  const c = parseCommand(text);
  try {
    switch (c.cmd) {
      case "start": return usage(BASE);
      case "check": return c.address ? await check(c.address) : "Send /check followed by an address, or just paste the address.";
      case "watch": return c.address ? await watch(c.address, chatId) : "Send /watch followed by an address.";
      case "report": return await report();
      case "unknown": return c.address ? await check(c.address) : `Unknown command. ${usage(BASE)}`;
      case "empty": case "text": return "Paste an EVM address (0x…) and I will screen it. /start for help.";
      default: return usage(BASE);
    }
  } catch (e) { return formatError(e, BASE); }
}

// ── Telegram long polling ──
async function tg(method, body) {
  const r = await fetch(`${TG}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(65000) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`);
  return j.result;
}
async function send(chatId, text) {
  for (const part of chunks(text, 3900)) await tg("sendMessage", { chat_id: chatId, text: part, disable_web_page_preview: true });
}
function chunks(s, n) { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out.length ? out : [""]; }

async function poll() {
  let offset = 0;
  console.log(`[bot] polling · host ${BASE} · webhook secret ${SECRET ? "set" : "UNSET"} · payer ${PAYER_KEY ? "set" : "none (free endpoints)"}`);
  await tg("setMyCommands", { commands: [
    { command: "check", description: "Screen an address" }, { command: "watch", description: "Alert me when its tier changes" },
    { command: "report", description: "Today's signed report" }, { command: "start", description: "What this bot does" } ] }).catch((e) => console.warn("[bot]", e.message));
  for (;;) {
    try {
      const updates = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
      for (const u of updates) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m || !m.text || !m.chat) continue;
        reply(m.text, m.chat.id).then((t) => send(m.chat.id, t)).catch((e) => console.warn("[bot] reply failed", e.message));
      }
    } catch (e) {
      console.warn("[bot] poll error", e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const once = process.argv.slice(2).join(" ").trim();
  if (once) {
    console.log(await reply(once, process.env.BOT_TEST_CHAT || "0"));
  } else if (!TOKEN) {
    console.log("CompliR Telegram bot (dry mode: TELEGRAM_BOT_TOKEN is not set)\n");
    console.log("  TELEGRAM_BOT_TOKEN=123:abc COMPLIR_URL=https://trycomplir.xyz BOT_WEBHOOK_SECRET=change-me node packages/bot/bot.mjs");
    console.log("  node packages/bot/bot.mjs \"/check 0x…\"   # run one command offline against COMPLIR_URL and print the reply\n");
    console.log(usage(BASE));
  } else {
    await poll();
  }
}
