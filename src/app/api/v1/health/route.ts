/**
 * GET /api/v1/health — liveness + public network config. Free. Never throws: bad env → 503 with `ok: false`.
 */
import { circleStatus } from "@/lib/circle/client";
import { signerMode } from "@/lib/chain/registryWriter";
import { config } from "@/lib/config";
import { ok } from "../../_lib/respond";
import type { HealthResponse } from "../../_lib/public-types";
import { exampleAddresses } from "../../_lib/examples";

export async function GET(): Promise<Response> {
  const time = new Date().toISOString();
  const examples = await exampleAddresses();
  try {
    const c = config();
    const body: HealthResponse = {
      ok: !c.COMPLIR_PAUSED,
      chainId: c.ARC_CHAIN_ID,
      network: {
        chainId: c.ARC_CHAIN_ID,
        explorerUrl: c.ARC_EXPLORER_URL,
        usdcAddress: c.USDC_ADDRESS,
        registryAddress: c.REGISTRY_ADDRESS ?? null,
        protocolBlocklistAddress: c.PROTOCOL_BLOCKLIST_ADDRESS ?? null,
      },
      paused: c.COMPLIR_PAUSED,
      x402: { disabled: c.X402_DISABLED, priceScreenUsdc: c.PRICE_SCREEN_USDC, priceWatchUsdc: c.PRICE_WATCH_USDC },
      signer: { mode: signerMode(), circle: circleStatus() },
      examples,
      time,
    };
    return ok(body);
  } catch (e) {
    const body: HealthResponse = {
      ok: false,
      chainId: null,
      network: { chainId: null, explorerUrl: "", usdcAddress: null, registryAddress: null, protocolBlocklistAddress: null },
      paused: true,
      x402: { disabled: true, priceScreenUsdc: 0, priceWatchUsdc: 0 },
      examples,
      time,
      error: e instanceof Error ? e.message : String(e),
    };
    return ok(body, { status: 503 });
  }
}
