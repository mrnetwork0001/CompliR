import { describe, expect, it } from "vitest";
import { encodeQr, qrSvgPath } from "./qr";

describe("qr encoder", () => {
  it("picks a version by length and builds a square matrix with finders", () => {
    const m = encodeQr("ethereum:0xc742ada2872a042dd36d2e706907b4036968960c@5042?value=1000000000000000000");
    expect(m.length).toBe(m[0].length);
    expect([25, 29, 33, 37]).toContain(m.length); // v2..v5
    // top-left finder outer ring is dark, inner ring light
    expect(m[0].slice(0, 7).every(Boolean)).toBe(true);
    expect(m[1][1]).toBe(false);
    expect(m[m.length - 8][8]).toBe(true); // dark module
    const { path, size } = qrSvgPath(m);
    expect(size).toBe(m.length + 4);
    expect(path.startsWith("M2 2h7")).toBe(true);
  });
  it("rejects payloads beyond version 10", () => {
    expect(() => encodeQr("x".repeat(300))).toThrow(/too long/);
  });
});
