import { describe, expect, it } from "vitest";
import { atomicToUsdc, usdcToAmountString, usdcToAtomic } from "./pricing";

describe("pricing", () => {
  it("converts USDC to 6dp atomic units exactly", () => {
    expect(usdcToAtomic(0.01)).toBe(10000n);
    expect(usdcToAtomic("0.05")).toBe(50000n);
    expect(usdcToAtomic(1)).toBe(1_000_000n);
    expect(usdcToAtomic("0.000001")).toBe(1n);
    expect(usdcToAmountString(0.01)).toBe("10000");
  });
  it("rejects bad input", () => {
    expect(() => usdcToAtomic("0.0000001")).toThrow();
    expect(() => usdcToAtomic(-1)).toThrow();
    expect(() => usdcToAtomic("abc")).toThrow();
  });
  it("formats atomic back to decimal", () => {
    expect(atomicToUsdc(10000n)).toBe("0.01");
    expect(atomicToUsdc("1000000")).toBe("1");
    expect(atomicToUsdc(1234567n)).toBe("1.234567");
    expect(atomicToUsdc(0n)).toBe("0");
  });
});
