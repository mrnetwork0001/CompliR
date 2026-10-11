/**
 * Demo addresses offered by the Explorer. The lead's `.data/overrides.json` pins these exact addresses
 * to HIGH / MEDIUM / LOW; if that file lists other addresses with a `tier`, they are surfaced too.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExampleAddress } from "./public-types";

const DEFAULTS: ExampleAddress[] = [
  { label: "demo HIGH", address: "0x000000000000000000000000000000000000dead", expectedTier: "HIGH" },
  { label: "demo MEDIUM", address: "0x000000000000000000000000000000000000beef", expectedTier: "MEDIUM" },
  { label: "demo LOW", address: "0x000000000000000000000000000000000000cafe", expectedTier: "LOW" },
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
    // Keep one per tier, HIGH → MEDIUM → LOW, so the UI always has three buttons.
    const byTier: ExampleAddress[] = [];
    for (const tier of ["HIGH", "MEDIUM", "LOW"] as const) {
      const hit = [...found.values()].find((e) => e.expectedTier === tier) ?? DEFAULTS.find((e) => e.expectedTier === tier)!;
      byTier.push(hit);
    }
    return byTier;
  } catch {
    return DEFAULTS;
  }
}
