import { describe, expect, it } from "vitest";
import { exampleAddresses } from "./examples";

describe("exampleAddresses", () => {
  it("yields the real example addresses: one sanctioned (HIGH) and our own wallet (LOW)", async () => {
    const ex = await exampleAddresses();
    expect(ex.map((e) => e.expectedTier)).toEqual(["HIGH", "LOW"]);
    for (const e of ex) expect(e.address).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
