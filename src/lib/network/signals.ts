/**
 * Cross-client network signal — the two things only a SHARED risk oracle can say (docs/SUGGESTIONS.md §G item 37):
 *
 *   heldElsewhere      "this address was rated HIGH by N other treasuries this week"   (from `screenings`)
 *   sharedFunder       "shares a hop-1 funder with N of YOUR payees"                   (from `payee_funders`, this client only)
 *   concentrationHint  "a funder of this address also funded N other payees/nodes"     (network-wide; fills bundle.concentration)
 *
 * Privacy: every value is a count, a timestamp, or the subject's OWN funder address. No other client's id, payee
 * or book ever leaves src/lib/network. Internal client ids (store/repo INTERNAL_CLIENT_IDS) never count as "others".
 *
 * Env (optional): NETWORK_WINDOW_DAYS=7  NETWORK_MIN_CONCENTRATION=3
 */
import type { Address, EvidenceBundle, NetworkSignal } from "../types";
import { concentrationAcrossNetwork, heldElsewhere, knownFundersOf, sharedFunderForClient, upsertPayeeFunders } from "./store";

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) ? n : d;
};
export function networkEnv() {
  const e = process.env;
  return {
    windowDays: Math.max(1, num(e.NETWORK_WINDOW_DAYS, 7)),
    /** network-wide shared-funder count needed before `concentrationHint` (→ HIGH_CONCENTRATION) is reported */
    minConcentration: Math.max(1, Math.floor(num(e.NETWORK_MIN_CONCENTRATION, 3))),
  };
}

export interface NetworkSignalOptions {
  /** the subject's hop-1 funders from the current trace; when omitted, funders remembered from earlier screens are used */
  funders?: Address[];
  /** unix seconds; default now */
  now?: number;
  windowDays?: number;
  minConcentration?: number;
}

export type NetworkSignalsFn = (subject: Address, clientId: string | null, opts?: NetworkSignalOptions) => Promise<NetworkSignal>;

export const emptyNetworkSignal = (windowDays = networkEnv().windowDays): NetworkSignal => ({
  heldElsewhere: { clients: 0, lastAt: null },
  sharedFunder: { count: 0, funder: null },
  concentrationHint: null,
  windowDays,
});

/** Counts only. Any store failure → the neutral signal (never throws). */
export const networkSignals: NetworkSignalsFn = async (subject, clientId, opts = {}) => {
  const env = networkEnv();
  const windowDays = opts.windowDays ?? env.windowDays;
  const minConc = opts.minConcentration ?? env.minConcentration;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const s = subject.toLowerCase() as Address;
  try {
    const funders = opts.funders ?? (await knownFundersOf(s));
    const [held, shared, conc] = await Promise.all([
      heldElsewhere(s, clientId, now - windowDays * 86_400),
      clientId ? sharedFunderForClient(clientId, s, funders) : Promise.resolve({ count: 0, funder: null }),
      concentrationAcrossNetwork(s, funders),
    ]);
    return {
      heldElsewhere: held,
      sharedFunder: shared,
      concentrationHint: conc && conc.otherPayees >= minConc ? conc : null,
      windowDays,
    };
  } catch (err) {
    console.warn("[network] signal unavailable:", (err as Error)?.message ?? err);
    return emptyNetworkSignal(windowDays);
  }
};

/** Hop-1 funder addresses of a bundle (de-duplicated, lowercased). */
export function hop1Funders(bundle: Pick<EvidenceBundle, "funders">): Address[] {
  return [...new Set(bundle.funders.filter((f) => f.hop === 1).map((f) => f.facts.address.toLowerCase() as Address))];
}

/**
 * Hook for the collector: after tracing, remember this client's (payee → hop-1 funders) so the shared-funder
 * signal exists for the client's NEXT payee. Fire-and-forget safe; never throws.
 */
export async function recordFunders(clientId: string | null | undefined, subject: Address, bundle: Pick<EvidenceBundle, "funders">, at?: number): Promise<number> {
  if (!clientId) return 0;
  try {
    return await upsertPayeeFunders(clientId, subject, hop1Funders(bundle), at);
  } catch (err) {
    console.warn("[network] recordFunders failed:", (err as Error)?.message ?? err);
    return 0;
  }
}
