/**
 * Network signal — public surface.
 *   networkSignals(subject, clientId, { funders })  → NetworkSignal (counts only)
 *   recordFunders(clientId, subject, bundle)         → remember hop-1 funders for the shared-funder signal
 */
export { networkSignals, recordFunders, hop1Funders, emptyNetworkSignal, networkEnv } from "./signals";
export type { NetworkSignalOptions, NetworkSignalsFn } from "./signals";
export { migrateNetwork, __resetNetworkMigration, heldElsewhere, sharedFunderForClient, concentrationAcrossNetwork, knownFundersOf, upsertPayeeFunders } from "./store";
