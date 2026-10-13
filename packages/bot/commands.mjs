/**
 * CompliR Telegram bot: pure command parsing + message formatting. No network, no Telegram - unit-tested.
 */
export const ADDR = /0x[0-9a-fA-F]{40}/;
const ADDR_EXACT = /^0x[0-9a-fA-F]{40}$/;

/** Telegram text → { cmd, address, arg }. A bare address (anywhere in the text) is a /check. */
export function parseCommand(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { cmd: "empty", address: null, arg: "" };
  const m = raw.match(/^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (m) {
    const cmd = m[1].toLowerCase(), arg = (m[2] ?? "").trim();
    const addr = (arg.match(ADDR) ?? [])[0] ?? null;
    switch (cmd) {
      case "start": case "help": return { cmd: "start", address: null, arg };
      case "check": case "screen": case "a": return { cmd: "check", address: addr ? addr.toLowerCase() : null, arg };
      case "watch": return { cmd: "watch", address: addr ? addr.toLowerCase() : null, arg };
      case "report": return { cmd: "report", address: null, arg };
      default: return { cmd: "unknown", address: addr ? addr.toLowerCase() : null, arg: raw };
    }
  }
  const addr = (raw.match(ADDR) ?? [])[0] ?? null;
  if (addr && !/[0-9a-fA-F]/.test(raw[raw.indexOf(addr) + 42] ?? "")) return { cmd: "check", address: addr.toLowerCase(), arg: raw };
  return { cmd: "text", address: null, arg: raw };
}

export function isAddress(v) { return typeof v === "string" && ADDR_EXACT.test(v); }

export const TIER_WORDS = {
  LOW: "Low risk. Nothing on sanctions lists, no tainted funding, normal history. Fine to transact.",
  MEDIUM: "Medium risk. Something needs a look: fresh wallet, thin history or an indirect link. Pay with limits or ask for due diligence first.",
  HIGH: "High risk. Sanctioned, blocklisted or funded by a sanctioned wallet. Do not send.",
};

export function usage(base) {
  return [
    "CompliR - counterparty risk oracle on Arc.",
    "",
    "Paste any EVM address and I reply with its risk tier (LOW / MEDIUM / HIGH), the reasons, and a link to the signed verdict.",
    "",
    "/check 0x…  - screen an address (or just paste it)",
    "/watch 0x…  - re-screen for 30 days; I message you when the tier changes",
    "/report     - today's signed traction report",
    "",
    `Verdicts: ${base}/a/<address>`,
  ].join("\n");
}

/** Verdict/attestation/check response → plain-language reply. Tolerates all three shapes. */
export function formatVerdict(v, base, note) {
  const address = v.address ?? "";
  const tier = v.tier ?? "UNKNOWN";
  const score = typeof v.score === "number" ? ` · score ${v.score}/100` : "";
  const lines = [`${tierMark(tier)} ${tier}${score}${v.headline ? ` · ${v.headline}` : ""}`, address, "", v.advice || TIER_WORDS[tier] || "No verdict stored for this address yet."];
  const reasons = Array.isArray(v.reasons) ? v.reasons.map((r) => (typeof r === "string" ? r : r.code)).filter(Boolean) : [];
  if (reasons.length) lines.push("", "Signals: " + reasons.join(", "));
  if (typeof v.rationale === "string" && v.rationale) lines.push("", v.rationale);
  else if (typeof v.summary === "string" && v.summary) lines.push("", v.summary);
  const lim = v.recommendedLimits || v.limits;
  if (lim) lines.push("", `Limits: ${lim.maxPerTxUsdc} USDC / tx · ${lim.maxPerDayUsdc} USDC / day`);
  lines.push("", `Report: ${base}/a/${address}`);
  if (v.decisionId) lines.push(`Decision: ${base}/log/${v.decisionId}`);
  if (v.edd && v.edd.url) lines.push(`Due diligence: ${v.edd.url}`);
  if (note) lines.push("", note);
  return lines.join("\n");
}
function tierMark(t) { return t === "LOW" ? "[LOW]" : t === "MEDIUM" ? "[MED]" : t === "HIGH" ? "[HIGH]" : "[?]"; }

export function formatWatch(w, base) {
  const until = w.expiresAt ? new Date(w.expiresAt * (w.expiresAt < 1e12 ? 1000 : 1)).toUTCString() : "30 days";
  return [`Watching ${w.address}`, `Watch ${w.id ?? ""} · until ${until}`, "I will message this chat when the tier changes.", `Report: ${base}/a/${w.address}`].join("\n");
}

/** GET /api/v1/report JSON → short summary. Shape: { date, hash, signer, report: { totals, screenings, watches, tierChanges, refunds, ... } } */
export function formatReport(r, base) {
  const rep = r.report ?? {};
  const lines = [`CompliR report · ${r.date ?? rep.date ?? "latest"} (UTC day)`];
  const s = rep.screenings, t = rep.totals, w = rep.watches, tc = rep.tierChanges, rf = rep.refunds;
  if (s && typeof s.total === "number") {
    const by = s.byTier ? ` · LOW ${s.byTier.LOW ?? 0} / MED ${s.byTier.MEDIUM ?? 0} / HIGH ${s.byTier.HIGH ?? 0}` : "";
    lines.push(`Screenings: ${s.total}${typeof s.outside === "number" ? ` (${s.outside} from outside clients)` : ""}${by}`);
  }
  if (t) lines.push(`Outside payers: ${t.outsidePayers ?? 0} · paid calls ${t.paidCalls ?? 0} · ${t.usdcIn ?? 0} USDC in${t.usdcRefunded ? ` · ${t.usdcRefunded} refunded` : ""}`);
  if (w) lines.push(`Watches: ${w.active ?? 0} active (${w.created ?? 0} new)`);
  if (tc && typeof tc.count === "number") lines.push(`Tier changes: ${tc.count}`);
  if (rf && typeof rf.count === "number" && rf.count) lines.push(`Refunds: ${rf.count} (${rf.sentUsdc ?? 0} USDC sent)`);
  if (Array.isArray(rep.mistakes) && rep.mistakes.length) lines.push(`Mistakes logged: ${rep.mistakes.length}`);
  if (lines.length === 1 && typeof rep.summary === "string") lines.push(rep.summary);
  if (r.hash) lines.push(`Hash ${String(r.hash).slice(0, 18)}… · signed by ${r.signer ?? "the agent"}`);
  lines.push(`${base}/report`);
  return lines.join("\n");
}

export function formatError(e, base) {
  const status = e && typeof e.status === "number" ? e.status : null;
  if (status === 402) return "This action needs a paid screen (x402). Set COMPLIR_PAYER_PRIVATE_KEY on the bot to pay 0.01 USDC per screen, or use the free check.";
  if (status === 503) return "CompliR is paused for maintenance. Try again shortly.";
  if (status === 404) return `No verdict found. Open ${base}/check to screen it in the browser.`;
  return `Could not reach CompliR: ${e && e.message ? e.message : String(e)}`;
}
