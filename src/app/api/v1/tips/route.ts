/**
 * Tip Market - public API.
 *   POST /api/v1/tips  submit a tip. API clients stake TIPS_STAKE_USDC (default 0.05) via x402 - the payment IS the stake
 *                      (settled before the tip is created; `settleFirst`). Same-origin browsers (the /tips page) submit
 *                      unstaked DEMO tips (submitter "demo", stake 0, no payout address). With X402_DISABLED the
 *                      submitter is "anonymous" (stake 0).
 *   GET  /api/v1/tips  public market view: last 50 tips (submitters anonymised), leaderboard, totals, market config. Free.
 */
import { config } from "@/lib/config";
import { HEADERS, PaymentPayloadSchema, decodeHeader, paymentConfig, withX402 } from "@/lib/pay";
import { ensurePaymentSink, isSameOriginBrowser } from "@/lib/payments";
import { db } from "@/lib/store/db";
import {
  ANON_SUBMITTER, CATEGORY_MULTIPLIER, DEMO_SUBJECT, DEMO_SUBMITTER, NewTipSchema, STRONG_URL_DOMAINS, TIP_CATEGORIES, bountyFor, leaderboard, listTips,
  payoutStatus, spentToday, submitTip, tipTotals, tipsEnv, toPublicLeader, toPublicTip, type PayoutMode, type PublicLeader, type PublicTip, type TipTotals,
} from "@/lib/tips";
import { ApiError, handle, ok } from "../../_lib/respond";
import { parseJson } from "../../_lib/parse";

export interface TipsMarketConfig {
  stakeUsdc: number;
  bountyUsdc: number;
  categoryMultiplier: Record<string, number>;
  /** bounty for a new submitter ("other") … a perfect-record submitter ("sanctions") */
  bountyRange: { min: number; max: number };
  dailyCapUsdc: number;
  spentTodayUsdc: number;
  payoutMode: PayoutMode;
  payoutReason: string;
  strongDomains: readonly string[];
  categories: readonly string[];
  x402Disabled: boolean;
  demoSubject: string;
  explorerUrl: string;
}
export interface TipsResponse {
  config: TipsMarketConfig;
  totals: TipTotals;
  leaderboard: PublicLeader[];
  items: PublicTip[];
  time: string;
}

export const GET = handle(async () => {
  const [items, leaders, totals, spent] = await Promise.all([listTips({ limit: 50 }), leaderboard(10), tipTotals(), spentToday()]);
  const env = tipsEnv();
  const ps = payoutStatus();
  const body: TipsResponse = {
    config: {
      stakeUsdc: env.stakeUsdc, bountyUsdc: env.bountyUsdc, categoryMultiplier: CATEGORY_MULTIPLIER,
      bountyRange: { min: bountyFor("other", 0.5), max: bountyFor("sanctions", 1) }, // new submitter … perfect record
      dailyCapUsdc: env.dailyCapUsdc, spentTodayUsdc: spent, payoutMode: ps.mode, payoutReason: ps.reason,
      strongDomains: STRONG_URL_DOMAINS, categories: TIP_CATEGORIES, x402Disabled: config().X402_DISABLED, demoSubject: DEMO_SUBJECT, explorerUrl: config().ARC_EXPLORER_URL,
    },
    totals, leaderboard: leaders.map(toPublicLeader), items: items.map(toPublicTip), time: new Date().toISOString(),
  };
  return ok(body);
});

/** x402 payer (authorization.from) from the request's payment header; null when absent / unparsable. */
function payerOf(req: Request): string | null {
  const raw = req.headers.get(HEADERS.paymentSignature) ?? req.headers.get(HEADERS.v1Payment);
  if (!raw) return null;
  try {
    const p = PaymentPayloadSchema.parse(decodeHeader(raw));
    return p.payload.authorization.from.toLowerCase();
  } catch { return null; }
}

/** Settlement tx of the stake the x402 sink just recorded for this payer (settleFirst → it is already there). */
async function stakeTxFor(payer: string, since: number): Promise<string | null> {
  try {
    const r = await db().execute({ sql: `SELECT tx_hash FROM payments WHERE lower(payer) = ? AND endpoint = '/api/v1/tips' AND created_at >= ? ORDER BY created_at DESC LIMIT 1`, args: [payer, since] });
    const row = r.rows[0] as Record<string, unknown> | undefined;
    return row?.tx_hash == null ? null : String(row.tx_hash);
  } catch { return null; }
}

async function submitHandler(req: Request): Promise<Response> {
  if (config().COMPLIR_PAUSED) throw new ApiError("SERVICE_PAUSED", "CompliR is paused for maintenance. No charge was made.");
  const input = await parseJson(req, NewTipSchema);
  const demo = isSameOriginBrowser(req);
  let submitter = DEMO_SUBMITTER;
  let stakeUsdc = 0;
  let stakeTx: string | null = null;
  if (!demo) {
    const payer = payerOf(req);
    const disabled = (() => { try { return paymentConfig().disabled; } catch { return true; } })();
    if (payer && !disabled) {
      submitter = payer;
      stakeUsdc = tipsEnv().stakeUsdc;
      stakeTx = await stakeTxFor(payer, Math.floor(Date.now() / 1000) - 300);
    } else {
      submitter = ANON_SUBMITTER;
    }
  }
  const tip = await submitTip(input, { submitter, stakeUsdc, stakeTx });
  const pub = toPublicTip(tip);
  return ok(
    {
      tip: pub,
      demo,
      note: demo
        ? "DEMO tip: submitted from the CompliR page without a stake. It is verified like any other tip but has no payout address, so a verified bounty is recorded, not sent."
        : stakeUsdc > 0
          ? `Stake of ${stakeUsdc} USDC settled via x402. Verified → bounty paid to ${submitter}; rejected → stake kept.`
          : "x402 is disabled on this deployment: tip accepted without a stake (anonymous, no payout address).",
      next: "The verifier runs every 5 minutes (worker/tips.ts or cron → /api/internal/tips). Poll GET /api/v1/tips/" + tip.id + ".",
    },
    { status: 201, headers: { "X-CompliR-Tip-Id": tip.id } },
  );
}

ensurePaymentSink();
const free = handle(submitHandler);
/** Same-origin page → unstaked demo tip; API clients → x402 stake (settled first, refund-safe), payer becomes the submitter. */
export const POST = async (req: Request, ctx: unknown) =>
  (isSameOriginBrowser(req)
    ? free
    : withX402(free, { priceUsdc: tipsEnv().stakeUsdc, description: "CompliR tip stake", resource: "/api/v1/tips", settleFirst: true }))(req, ctx);
