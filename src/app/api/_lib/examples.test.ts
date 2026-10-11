import { describe, expect, it } from "vitest";
import { exampleAddresses } from "./examples";

describe("exampleAddresses", () => {
  it("always yields exactly one HIGH, MEDIUM and LOW demo address", async () => {
    const ex = await exampleAddresses();
    expect(ex.map((e) => e.expectedTier)).toEqual(["HIGH", "MEDIUM", "LOW"]);
    for (const e of ex) expect(e.address).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
