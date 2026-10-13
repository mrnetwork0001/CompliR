/**
 * Event reactor - public surface.
 *   pollBlocklistEvents(opts)                 one tick: USDC Blacklisted/UnBlacklisted logs → re-screen → webhooks
 *   simulateBlocklistEvent(address, kind)     the "blacklist drill" (same handler, no chain event needed)
 *   rescreenAddressNow(address, reason)       re-screen + push to every watch (used by both)
 */
export { pollBlocklistEvents, handleBlocklistEvent, simulateBlocklistEvent, rescreenAddressNow, matchesFor, kindOf, BLOCKLIST_EVENTS, BLOCKLIST_EVENT_NAMES } from "./blocklist";
export type { BlocklistEvent, EventsClient, HandlerDeps, PollOptions, PollResult, RescreenResult, ScreenFn } from "./blocklist";
export { migrateEvents, __resetEventsMigration, getEventsCursor, setEventsCursor, getEventsMeta, listEventLogs, eventLogsOf, activeWatchesFor } from "./store";
export type { BlocklistEventKind, EventLogEntry, EventMatch } from "./store";
export { eventsEnv } from "./env";
