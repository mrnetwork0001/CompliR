import { keccak256, stringToHex, concatHex, toHex } from "viem";
import { canonicalize } from "../attest/canonical";
import { insertDecision, lastDecision, getDecisionRow, listDecisionRows, decisionsInRange } from "../store";
import type { Address, DecisionKind, DecisionLogEntry } from "../types";

export const GENESIS_HASH = `0x${"0".repeat(64)}` as const;

export function entryHash(prevHash: `0x${string}`, payload: unknown, seq: number, kind: DecisionKind): `0x${string}` {
  return keccak256(concatHex([prevHash, stringToHex(canonicalize(payload)), toHex(seq, { size: 8 }), stringToHex(kind)]));
}
function newId(seq: number): string {
  return `dec_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

let chain: Promise<unknown> = Promise.resolve(); // serialise appends in-process
export function appendDecision(input: { kind: DecisionKind; subject: Address | null; clientId: string | null; payload: unknown }): Promise<DecisionLogEntry> {
  const run = async () => {
    const prev = await lastDecision();
    const seq = (prev?.seq ?? 0) + 1;
    const prevHash = prev?.hash ?? GENESIS_HASH;
    const entry: DecisionLogEntry = {
      id: newId(seq), seq, kind: input.kind, subject: input.subject, clientId: input.clientId, payload: input.payload,
      prevHash, hash: entryHash(prevHash, input.payload, seq, input.kind), createdAt: Math.floor(Date.now() / 1000), anchorTx: null,
    };
    await insertDecision(entry);
    return entry;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}
export const getDecision = getDecisionRow;
export const listDecisions = listDecisionRows;

export async function verifyChain(fromSeq = 1, toSeq?: number): Promise<{ ok: boolean; brokenAt: number | null; length: number }> {
  const last = await lastDecision();
  const end = toSeq ?? last?.seq ?? 0;
  if (end < fromSeq) return { ok: true, brokenAt: null, length: 0 };
  const rows = await decisionsInRange(fromSeq, end);
  let prevHash: `0x${string}` = fromSeq === 1 ? GENESIS_HASH : (await decisionsInRange(fromSeq - 1, fromSeq - 1))[0]?.hash ?? GENESIS_HASH;
  let expectSeq = fromSeq;
  for (const e of rows) {
    if (e.seq !== expectSeq || e.prevHash !== prevHash || entryHash(prevHash, e.payload, e.seq, e.kind) !== e.hash) {
      return { ok: false, brokenAt: e.seq, length: rows.length };
    }
    prevHash = e.hash; expectSeq++;
  }
  return { ok: true, brokenAt: null, length: rows.length };
}
