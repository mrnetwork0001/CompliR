/**
 * GET /api/v1/numbers — public, honest counters (own wallets excluded). Free. Spec §2.7.
 */
import { publicStats } from "@/lib/store";
import { handle, ok } from "../../_lib/respond";
import type { PublicStats } from "../../_lib/public-types";

export const GET = handle(async () => {
  const stats: PublicStats = await publicStats();
  return ok(stats);
});
