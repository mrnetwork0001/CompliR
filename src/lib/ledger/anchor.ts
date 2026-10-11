import { keccak256, concatHex } from "viem";
import { unanchoredDecisions, markAnchored } from "../store";
import { appendDecision } from "./decisionLog";

type Hex = `0x${string}`;
const pair = (a: Hex, b: Hex): Hex => keccak256(concatHex(a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]));

export function computeMerkleRoot(hashes: Hex[]): Hex {
  if (hashes.length === 0) return `0x${"0".repeat(64)}`;
  let level = [...hashes];
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(pair(level[i], level[i + 1]));
    level = next;
  }
  return level[0];
}
export function merkleProof(hashes: Hex[], index: number): Hex[] {
  const proof: Hex[] = []; let level = [...hashes]; let i = index;
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    proof.push(level[i ^ 1]);
    const next: Hex[] = [];
    for (let j = 0; j < level.length; j += 2) next.push(pair(level[j], level[j + 1]));
    level = next; i = Math.floor(i / 2);
  }
  return proof;
}
export function verifyProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  return proof.reduce((h, p) => pair(h, p), leaf) === root;
}

/** Anchor every unanchored decision. The on-chain write is injected so this module has no chain dependency. */
export async function anchorPending(writeRoot: (root: Hex, fromSeq: number, toSeq: number) => Promise<Hex>) {
  const batch = await unanchoredDecisions();
  if (batch.length === 0) return null;
  const root = computeMerkleRoot(batch.map((e) => e.hash));
  const fromSeq = batch[0].seq, toSeq = batch[batch.length - 1].seq;
  const tx = await writeRoot(root, fromSeq, toSeq);
  await markAnchored(fromSeq, toSeq, tx);
  await appendDecision({ kind: "ANCHOR", subject: null, clientId: null, payload: { root, fromSeq, toSeq, tx, count: batch.length } });
  return { root, fromSeq, toSeq, tx, count: batch.length };
}
