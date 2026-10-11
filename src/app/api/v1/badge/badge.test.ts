import { describe, expect, it } from "vitest";
import { badgeLabel, fmtBadgeDate, renderBadge } from "./badge";

describe("badge svg", () => {
  it("renders tier + valid-until", () => {
    const svg = renderBadge({ status: "MEDIUM", validUntil: 1_760_000_000, score: 37 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Screened by CompliR");
    expect(svg).toContain(`MEDIUM · valid until ${fmtBadgeDate(1_760_000_000)}`);
    expect(svg).toContain("#b45309");
  });
  it("is grey and says unknown without an attestation", () => {
    const svg = renderBadge({ status: "UNKNOWN" });
    expect(svg).toContain("unknown");
    expect(svg).toContain("#6b7280");
  });
  it("marks expired attestations", () => {
    expect(badgeLabel({ status: "EXPIRED", validUntil: 1_700_000_000 })).toMatch(/^expired 2023-11-14$/);
  });
  it("escapes nothing dangerous and has no script", () => {
    const svg = renderBadge({ status: "HIGH", validUntil: 1_760_000_000 });
    expect(svg).not.toContain("<script");
  });
});
