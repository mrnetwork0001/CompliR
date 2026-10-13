/**
 * Example addresses offered by the Explorer. Real addresses only; `.data/overrides.json` entries with a `tier` are surfaced when present.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExampleAddress } from "./public-types";

/** Real addresses only: a sanctioned wallet (OFAC SDN / JP MOF: Ronin Bridge exploiter, Lazarus Group) and CompliR's own live wallet. */
const DEFAULTS: ExampleAddress[] = [
  { label: "Lazarus Group · Ronin exploiter (sanctioned)", address: "0x098b716b8aaf21512996dc57eb0615e2383e2f96", expectedTier: "HIGH" },
  { label: "CompliR treasury wallet (ours)", address: "0xc742ada2872a042dd36d2e706907b4036968960c", expectedTier: "LOW" },
];

const TIERS = new Set(["LOW", "MEDIUM", "HIGH"]);
const ADDR = /^0x[0-9a-fA-F]{40}$/;

export async function exampleAddresses(): Promise<ExampleAddress[]> {
  try {
    const raw = await readFile(path.join(process.cwd(), ".data", "overrides.json"), "utf8");
    const json: unknown = JSON.parse(raw);
    const found = new Map<string, ExampleAddress>();
    const visit = (addr: string, v: unknown) => {
      if (!ADDR.test(addr) || !v || typeof v !== "object") return;
      const tier = (v as { tier?: unknown }).tier;
      if (typeof tier === "string" && TIERS.has(tier)) {
        const label = (v as { label?: unknown }).label;
        found.set(addr.toLowerCase(), {
          label: typeof label === "string" ? label : `demo ${tier}`,
          address: addr.toLowerCase(),
          expectedTier: tier as ExampleAddress["expectedTier"],
        });
      }
    };
    if (Array.isArray(json)) {
      for (const item of json) if (item && typeof item === "object" && "address" in item) visit(String(item.address), item);
    } else if (json && typeof json === "object") {
      for (const [k, v] of Object.entries(json as Record<string, unknown>)) visit(k, v);
    }
    if (found.size === 0) return DEFAULTS;
    return [...found.values()];
  } catch {
    return DEFAULTS;
  }
}
