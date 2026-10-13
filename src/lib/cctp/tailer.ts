/**
 * CCTP inbound screening: tail Arc's MessageTransmitterV2 for `MessageReceived`, decode the BurnMessageV2 body
 * (source domain, source-chain `messageSender`, `mintRecipient`, amount) and, for every mint ≥ CCTP_MIN_USDC:
 *   - screen the SOURCE SENDER: OpenSanctions (yente CryptoWallet) + source-chain USDC isBlacklisted (public RPC)
 *   - screen the ARC RECIPIENT with the real pipeline (`screen({address, clientId: "cctp"})`; attested + ledgered),
 *     reusing the recipient's last cctp verdict inside CCTP_RESCREEN_HOURS
 *   - record cctp_inbound (flagged = sender sanctioned or blacklisted) → EvidenceBundle.inbound / INBOUND_FLAGGED
 * Cursor in cctp_meta, advanced only through contiguously fetched blocks; a lag > CCTP_MAX_LAG skips ahead.
 * Budget per tick: CCTP_MAX_BLOCKS blocks and CCTP_MAX_SCREENS recipient screens - when the screen budget runs out the
 * cursor stops at the last fully processed block and the rest is picked up next tick.
 */
import { decodeEventLog, type Log, type PublicClient } from "viem";
import { arcClient } from "../evidence/rpc";
import { isRangeError, isRateLimited, lower, rpcGate, rpcRetry, toUsdc6 } from "../evidence/util";
import { screen as pipelineScreen, type ScreenOptions } from "../pipeline";
import type { Address, ScreenRequest, Tier, Verdict } from "../types";
import { ARC_CCTP, CCTP_EVENTS, bytes32ToAddress, decodeBurnMessage, sourceChain } from "./abi";
import { cctpEnv } from "./env";
import { checkSourceSender, type SenderCheckOptions } from "./sender";
import { getCursor, hasInbound, insertInbound, lastVerdictFor, setCursor, setMeta, type InboundRow } from "./store";

export const CCTP_CLIENT_ID = "cctp";

export type TailClient = Pick<PublicClient, "getBlockNumber" | "getLogs" | "getBlock">;
export type ScreenFn = (req: ScreenRequest, opts?: ScreenOptions) => Promise<Verdict>;

export interface InboundMint {
  txHash: `0x${string}`;
  logIndex: number;
  block: number;
  sourceDomain: number;
  sourceChain: string;
  /** remote TokenMessenger (the CCTP `sender`) */
  remoteMessenger: Address;
  burnToken: Address;
  sourceSender: Address;
  recipient: Address;
  amount: bigint; // 6 dp
  feeExecuted: bigint;
  amountUsdc: string;
}

/** Decode one MessageReceived log into an inbound mint (null = not a v1 burn message). */
export function decodeInbound(log: Pick<Log, "data" | "topics" | "transactionHash" | "logIndex" | "blockNumber">): InboundMint | null {
  let args;
  try {
    ({ args } = decodeEventLog({ abi: CCTP_EVENTS, eventName: "MessageReceived", data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] }));
  } catch {
    return null;
  }
  const body = decodeBurnMessage(args.messageBody);
  if (!body || body.version !== 1) return null;
  const amount = body.amount;
  if (amount <= 0n) return null;
  const domain = Number(args.sourceDomain);
  return {
    txHash: (log.transactionHash ?? "0x").toLowerCase() as `0x${string}`,
    logIndex: Number(log.logIndex ?? 0),
    block: Number(log.blockNumber ?? 0n),
    sourceDomain: domain,
    sourceChain: sourceChain(domain).name,
    remoteMessenger: bytes32ToAddress(args.sender),
    burnToken: body.burnToken,
    sourceSender: body.messageSender,
    recipient: body.mintRecipient,
    amount,
    feeExecuted: body.feeExecuted,
    amountUsdc: toUsdc6(amount, 6),
  };
}

export interface TailOptions {
  client?: TailClient;
  screenFn?: ScreenFn;
  sender?: SenderCheckOptions;
  fromBlock?: number;
  toBlock?: number;
  minUsdc?: number;
  maxScreens?: number;
  maxBlocks?: number;
  now?: number;
}

export interface TailResult {
  fromBlock: number;
  toBlock: number;
  head: number;
  cursorBlock: number | null;
  logs: number;
  mints: number;
  belowMin: number;
  recorded: number;
  skippedSeen: number;
  screened: number;
  reused: number;
  flagged: number;
  partial: boolean;
  rateLimited: boolean;
  error: string | null;
  ms: number;
  items: { tx: `0x${string}`; sourceChain: string; amountUsdc: string; flagged: boolean; recipientTier: Tier | null; senderChecks: InboundRow["senderChecks"] }[];
}

export async function tailCctpOnce(opts: TailOptions = {}): Promise<TailResult> {
  const t0 = Date.now();
  const env = cctpEnv();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const client = opts.client ?? (arcClient() as TailClient);
  const screenFn = opts.screenFn ?? pipelineScreen;
  const minUsdc = opts.minUsdc ?? env.minUsdc;
  const maxScreens = opts.maxScreens ?? env.maxScreens;
  const maxBlocks = opts.maxBlocks ?? env.maxBlocks;
  const transmitter = env.messageTransmitter ?? ARC_CCTP.messageTransmitter;

  const res: TailResult = {
    fromBlock: 0, toBlock: 0, head: 0, cursorBlock: null, logs: 0, mints: 0, belowMin: 0, recorded: 0, skippedSeen: 0, screened: 0, reused: 0, flagged: 0,
    partial: false, rateLimited: false, error: null, ms: 0, items: [],
  };
  try {
    const head = Number(await rpcGate.run(() => rpcRetry(() => client.getBlockNumber())));
    res.head = head;
    const cursor = await getCursor();
    let from = opts.fromBlock ?? (cursor == null ? Math.max(0, head - env.lookbackBlocks) : cursor + 1);
    if (opts.fromBlock == null && head - from > env.maxLag) from = head - env.maxLag;
    const to = Math.min(opts.toBlock ?? head, from + maxBlocks - 1);
    res.fromBlock = from;
    res.toBlock = to;
    if (to < from) {
      res.cursorBlock = cursor;
      res.ms = Date.now() - t0;
      return res;
    }

    // fetch logs (bisect on range/result caps)
    const logs: Log[] = [];
    const queue: [bigint, bigint][] = [[BigInt(from), BigInt(to)]];
    let through = from - 1;
    while (queue.length) {
      const [a, b] = queue.shift()!;
      try {
        const got = await rpcGate.run(() => rpcRetry(() => client.getLogs({ address: transmitter, event: CCTP_EVENTS[0], fromBlock: a, toBlock: b })));
        logs.push(...(got as Log[]));
        through = Number(b);
      } catch (err) {
        if (isRangeError(err) && b > a) {
          const mid = a + (b - a) / 2n;
          queue.unshift([a, mid], [mid + 1n, b]);
          continue;
        }
        if (isRateLimited(err)) res.rateLimited = true;
        res.partial = true;
        res.error = (err as Error)?.message?.slice(0, 200) ?? String(err);
        break;
      }
    }
    res.logs = logs.length;
    logs.sort((x, y) => Number(x.blockNumber ?? 0n) - Number(y.blockNumber ?? 0n) || Number(x.logIndex ?? 0) - Number(y.logIndex ?? 0));

    let screens = 0;
    let lastDone = through;
    const blockTimes = new Map<number, number | null>();
    for (const log of logs) {
      const m = decodeInbound(log);
      if (!m) continue;
      res.mints++;
      if (Number(m.amount) / 1e6 < minUsdc) {
        res.belowMin++;
        continue;
      }
      if (await hasInbound(m.txHash, m.logIndex)) {
        res.skippedSeen++;
        continue;
      }
      // out of screen budget → stop here; cursor rests on the previous block so this log is retried next tick
      const reuse = await lastVerdictFor(m.recipient);
      const canReuse = !!reuse && now - reuse.createdAt < env.rescreenHours * 3600;
      if (!canReuse && screens >= maxScreens) {
        res.partial = true;
        lastDone = Math.min(lastDone, m.block - 1);
        break;
      }
      let blockTime = blockTimes.get(m.block);
      if (blockTime === undefined) {
        blockTime = await rpcGate.run(() => rpcRetry(() => client.getBlock({ blockNumber: BigInt(m.block) }))).then((b) => Number(b.timestamp), () => null);
        blockTimes.set(m.block, blockTime);
      }

      const senderP = checkSourceSender(m.sourceSender, m.sourceDomain, { timeoutMs: env.timeoutMs, ...opts.sender });
      let verdict: { decisionId: string; tier: Tier; score: number } | null = null;
      if (canReuse && reuse) {
        verdict = { decisionId: reuse.recipientDecisionId!, tier: reuse.recipientTier!, score: reuse.recipientScore ?? 0 };
        res.reused++;
      } else {
        screens++;
        try {
          const v = await screenFn({ address: lower(m.recipient), clientId: CCTP_CLIENT_ID, amountUsdc: Number(m.amount) / 1e6 });
          verdict = { decisionId: v.decisionId, tier: v.tier, score: v.score };
          res.screened++;
        } catch (e) {
          console.warn("[cctp] recipient screen failed:", (e as Error)?.message);
        }
      }
      const sender = await senderP;
      const row: Omit<InboundRow, "id"> = {
        txHash: m.txHash, logIndex: m.logIndex, block: m.block, blockTime, sourceDomain: m.sourceDomain, sourceChain: m.sourceChain,
        sourceSender: m.sourceSender, recipient: lower(m.recipient), amountUsdc: m.amountUsdc, burnToken: m.burnToken,
        senderSanctions: sender.sanctions, senderBlacklisted: sender.blacklisted, senderChecks: sender.checks,
        recipientDecisionId: verdict?.decisionId ?? null, recipientTier: verdict?.tier ?? null, recipientScore: verdict?.score ?? null,
        flagged: sender.flagged, createdAt: now,
      };
      if (await insertInbound(row)) res.recorded++;
      if (sender.flagged) res.flagged++;
      res.items.push({ tx: m.txHash, sourceChain: m.sourceChain, amountUsdc: m.amountUsdc, flagged: sender.flagged, recipientTier: verdict?.tier ?? null, senderChecks: sender.checks });
    }
    if (lastDone >= from) await setCursor(lastDone);
    res.cursorBlock = lastDone >= from ? lastDone : cursor;
  } catch (err) {
    res.error = (err as Error)?.message?.slice(0, 300) ?? String(err);
    res.partial = true;
  }
  res.ms = Date.now() - t0;
  await setMeta("last_tick", JSON.stringify({ at: now, ...res, items: res.items.slice(0, 20) })).catch(() => undefined);
  return res;
}
