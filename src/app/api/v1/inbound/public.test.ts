import { describe, expect, it } from "vitest";
import { maskAddress } from "@/lib/store";
import type { InboundRow } from "@/lib/cctp/store";
import { toPublicInbound } from "./public";

describe("GET /api/v1/inbound shape", () => {
  it("masks the sender, keeps counts/datasets only, carries the recipient verdict", () => {
    const row: InboundRow = {
      id: 1, txHash: `0x${"ab".repeat(32)}`, logIndex: 3, block: 100, blockTime: 1_760_400_000, sourceDomain: 6, sourceChain: "base",
      sourceSender: "0x098b716b8aaf21512996dc57eb0615e2383e2f96", recipient: "0x2166d3a311a848d7713b6ef7a46e70f75d36fd67", amountUsdc: "5000.000000",
      burnToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", senderSanctions: [{ source: "opensanctions", entityId: "x", caption: "Lazarus Group", datasets: ["us_ofac_sdn"], score: 1, matchedOn: "address" }],
      senderBlacklisted: false, senderChecks: { sanctions: "ok", blacklist: "ok" }, recipientDecisionId: "dec_1", recipientTier: "LOW", recipientScore: 3, flagged: true, createdAt: 1_760_400_050,
    };
    const p = toPublicInbound(row, maskAddress);
    expect(p.senderMasked).toBe(maskAddress(row.sourceSender));
    expect(p.senderMasked).not.toContain("716b8aaf");
    expect(JSON.stringify(p)).not.toContain("Lazarus");
    expect(p.sender).toEqual({ sanctioned: true, datasets: ["us_ofac_sdn"], blacklisted: false, checks: { sanctions: "ok", blacklist: "ok" } });
    expect(p.recipient_screen).toEqual({ decisionId: "dec_1", tier: "LOW", score: 3 });
    expect(p.at).toBe("2025-10-14T00:00:00.000Z".replace("2025", new Date(1_760_400_000 * 1000).toISOString().slice(0, 4)));
    expect(p.flagged).toBe(true);
    expect(p.sourceChain).toBe("base");
  });
});
