import "../__tests__/setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Address, Reason, Verdict } from "../types";
import { adviceFor, adviceFromCodes, headlineFor, plainVerdict, rankedReasons, toCheckResponse } from "./plain";
import { extractFromInvoiceText, extractFromLink, parseEip681, parseUrlLink, vendorKey } from "./extract";
import { TokenBucket } from "./ratelimit";
import { insertAttestation, migrate, recordScreening } from "../store";
import { addressHistory } from "./history";

const r = (code: Reason["code"], weight: number, evidence: Record<string, unknown> = {}): Reason => ({ code, weight, evidence });
const limits = { maxPerTxUsdc: 250, maxPerDayUsdc: 1000 };

describe("plain-language mapping", () => {
  it("HIGH + OFAC + Circle → Don't pay with the merged sentence", () => {
    const reasons = [r("SANCTIONS_DIRECT", 100, { hits: [{ datasets: ["us_ofac_sdn"] }] }), r("USDC_BLACKLISTED", 100)];
    const p = plainVerdict({ tier: "HIGH", reasons, recommendedLimits: { maxPerTxUsdc: 0, maxPerDayUsdc: 0 } });
    expect(p.headline).toBe("Don't pay.");
    expect(p.advice).toBe("This wallet is on the OFAC sanctions list and Circle has blocked it on USDC.");
    expect(p.action).toBe("hold");
  });
  it("MEDIUM → Pay up to N USDC with the top reason", () => {
    const p = plainVerdict({ tier: "MEDIUM", reasons: [r("FUNDER_2HOP_SANCTIONED", 15, { hop: 2 }), r("FRESH_WALLET", 8)], recommendedLimits: limits });
    expect(p.headline).toBe("Pay up to 250 USDC.");
    expect(p.advice).toBe("Its funders two hops back include a sanctioned wallet. It is a fresh wallet: first seen less than a week ago or fewer than five transactions.");
    expect(p.action).toBe("limit");
  });
  it("LOW + CLEAN → Safe to pay", () => {
    const p = plainVerdict({ tier: "LOW", reasons: [r("CLEAN", 0)], recommendedLimits: limits });
    expect(p.headline).toBe("Safe to pay.");
    expect(p.advice).toBe("No sanctions, no blocklist, normal history.");
    expect(p.action).toBe("pay");
  });
  it("LOW with a mild reason says so and adds 'Nothing serious.'", () => {
    expect(adviceFor([r("FRESH_WALLET", 8)], "LOW")).toMatch(/fresh wallet.*Nothing serious\.$/);
  });
  it("ranks by weight and drops CLEAN; non-OFAC sanctions read 'a sanctions list'", () => {
    const ranked = rankedReasons([r("CLEAN", 0), r("FRESH_WALLET", 8), r("SANCTIONS_DIRECT", 100, { hits: [{ datasets: ["eu_fsf"] }] })]);
    expect(ranked.map((x) => x.code)).toEqual(["SANCTIONS_DIRECT", "FRESH_WALLET"]);
    expect(adviceFor(ranked, "HIGH")).toBe("This wallet is on a sanctions list. It is a fresh wallet: first seen less than a week ago or fewer than five transactions.");
    expect(headlineFor("MEDIUM", { maxPerTxUsdc: 1234.5, maxPerDayUsdc: 1 })).toBe("Pay up to 1,234.5 USDC.");
  });
  it("adviceFromCodes ranks codes without weights", () => {
    expect(adviceFromCodes(["NO_HISTORY", "SANCTIONS_DIRECT", "USDC_BLACKLISTED", "CLEAN"], "HIGH")).toBe("This wallet is on a sanctions list and Circle has blocked it on USDC. It has never transacted on Arc.");
    expect(adviceFromCodes(["CLEAN"], "LOW")).toBe("No sanctions, no blocklist, normal history.");
  });
  it("toCheckResponse carries the share url, codes and attestation", () => {
    const v = fakeVerdict("0x098b716b8aaf21512996dc57eb0615e2383e2f96", "HIGH", 100, [r("USDC_BLACKLISTED", 100), r("SANCTIONS_DIRECT", 100)], "dec_x");
    const c = toCheckResponse(v, "https://complir.example/a/0x098b716b8aaf21512996dc57eb0615e2383e2f96", "link");
    expect(c.shareUrl).toContain("/a/0x098b");
    expect(c.reasons).toEqual(["USDC_BLACKLISTED", "SANCTIONS_DIRECT"]);
    expect(c.headline).toBe("Don't pay.");
    expect(c.attestation.attester).toBe(v.attestation.attester);
    expect(c.source).toBe("link");
  });
});

describe("link extraction", () => {
  const A = "0x098b716b8aaf21512996dc57eb0615e2383e2f96";
  it("EIP-681 native transfer with chain and value", () => {
    const x = parseEip681(`ethereum:${A.toUpperCase().replace("0X", "0x")}@5042?value=2.5e18`)!;
    expect(x.address).toBe(A);
    expect(x.chainId).toBe(5042);
    expect(x.amountUsdc).toBe(2.5);
    expect(x.kind).toBe("eip681");
  });
  it("EIP-681 ERC-20 transfer takes the recipient from address=, amount from uint256=", () => {
    const x = parseEip681(`ethereum:0x3600000000000000000000000000000000000000@5042/transfer?address=${A}&uint256=250000000`)!;
    expect(x.address).toBe(A);
    expect(x.amountUsdc).toBe(250);
  });
  it("CompliR /pay/<id> link: address in the query wins, otherwise the id is returned for resolution", () => {
    const withAddr = parseUrlLink(`https://complir.example/pay/inv_1?to=${A}&amount=12`)!;
    expect(withAddr.kind).toBe("complir-pay");
    expect(withAddr.address).toBe(A);
    expect(withAddr.amountUsdc).toBe(12);
    const noAddr = parseUrlLink("https://complir.example/pay/inv_42")!;
    expect(noAddr.address).toBeNull();
    expect(noAddr.payId).toBe("inv_42");
    const addrId = parseUrlLink(`https://complir.example/pay/${A}`)!;
    expect(addrId.address).toBe(A);
    expect(addrId.payId).toBeNull();
  });
  it("any URL carrying an address in path / hash", () => {
    expect(extractFromLink(`https://explorer.arc.net/address/${A}`).address).toBe(A);
    expect(extractFromLink(`https://app.example/#/send/${A}`).address).toBe(A);
    expect(extractFromLink(`  ${A}  `).kind).toBe("address");
    expect(extractFromLink("https://example.com/nothing").address).toBeNull();
    expect(extractFromLink("not a link").kind).toBe("none");
    expect(extractFromLink(`pay ${A} please`).address).toBe(A);
  });
});

describe("invoice text extraction", () => {
  const A = "0x098b716b8aaf21512996dc57eb0615e2383e2f96";
  const B = "0xc742ada2872a042dd36d2e706907b4036968960c";
  it("finds distinct addresses, labelled vendor and total", () => {
    const text = `INVOICE #1042\nDate: 2026-10-01\nFrom: Northwind Traders Ltd\nBill to: Acme\nPay to USDC wallet ${A}\nBackup ${B}\nAgain ${A.toUpperCase().replace("0X", "0x")}\nTotal due: 1,250.00 USDC`;
    const x = extractFromInvoiceText(text);
    expect(x.addresses).toEqual([A, B]);
    expect(x.vendorName).toBe("Northwind Traders Ltd");
    expect(x.amountUsdc).toBe(1250);
  });
  it("falls back to the first name-like line", () => {
    const x = extractFromInvoiceText(`Invoice\nContoso Cloud Services\n123 Main St\nwallet: ${B}`);
    expect(x.vendorName).toBe("Contoso Cloud Services");
    expect(x.addresses).toEqual([B]);
    expect(x.amountUsdc).toBeNull();
  });
  it("vendorKey normalises for the local history", () => {
    expect(vendorKey("  Northwind, Traders LTD. ")).toBe("northwind traders ltd");
  });
});

describe("token bucket", () => {
  it("allows capacity per window then refills", () => {
    const b = new TokenBucket(3, 60_000);
    const t0 = 1_000_000;
    expect(b.take("ip", t0).ok).toBe(true);
    expect(b.take("ip", t0).ok).toBe(true);
    expect(b.take("ip", t0).ok).toBe(true);
    const denied = b.take("ip", t0);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(b.take("other", t0).ok).toBe(true);
    expect(b.take("ip", t0 + 20_001).ok).toBe(true);
  });
});

describe("address history", () => {
  const A = "0x00000000000000000000000000000000000c4ec1" as Address;
  beforeAll(async () => {
    await migrate();
    const v1 = fakeVerdict(A, "LOW", 5, [r("CLEAN", 0)], "dec_h1", 1_700_000_000);
    const v2 = fakeVerdict(A, "HIGH", 90, [r("USDC_BLACKLISTED", 100)], "dec_h2", 1_700_000_100);
    for (const [v, client] of [[v1, "web-explorer"], [v2, "0xabc"]] as const) {
      await insertAttestation(v);
      await recordScreening(v, client, client === "web-explorer" ? "own" : "outside");
    }
  });
  it("returns every verdict newest-first with client class only, tier changes and counts", async () => {
    const h = await addressHistory(A);
    expect(h.address).toBe(A);
    expect(h.anonymised).toBe(true);
    expect(h.verdicts.length).toBe(2);
    expect(h.verdicts.map((v) => v.decisionId)).toEqual(["dec_h2", "dec_h1"]);
    expect(h.verdicts[0].requester).toBe("outside");
    expect(h.verdicts[1].requester).toBe("own");
    expect(JSON.stringify(h)).not.toContain("0xabc");
    expect(h.verdicts[0].tierChanged).toBe(true);
    expect(h.verdicts[0].attester).toMatch(/^0x[0-9a-f]{40}$/);
    expect(h.verdicts[0].validUntil).toBeTruthy();
    expect(h.tierChanges).toEqual([{ at: h.verdicts[0].screenedAt, from: "LOW", to: "HIGH", decisionId: "dec_h2", via: "verdict" }]);
    expect(h.latest?.tier).toBe("HIGH");
    expect(h.latest?.headline).toBe("Don't pay.");
    expect(h.latest?.advice).toBe("Circle has blocked this wallet on USDC.");
    expect(h.counts).toEqual({ verdicts: 2, high: 1, medium: 0, low: 1, outsideRequests: 1 });
    expect(h.openEdd).toEqual([]);
    expect(h.firstSeenAt).toBe(h.verdicts[1].screenedAt);
  });
  it("is empty for an unseen address", async () => {
    const h = await addressHistory("0x00000000000000000000000000000000000c4ec2" as Address);
    expect(h.latest).toBeNull();
    expect(h.verdicts).toEqual([]);
    expect(h.counts.verdicts).toBe(0);
  });
});

function fakeVerdict(address: string, tier: Verdict["tier"], score: number, reasons: Reason[], decisionId: string, issuedAt = 1_700_000_000): Verdict {
  const attester = "0x1111111111111111111111111111111111111111" as Address;
  return {
    address: address as Address, score, tier, recommendedLimits: tier === "HIGH" ? { maxPerTxUsdc: 0, maxPerDayUsdc: 0 } : limits, reasons,
    rationale: "test", eddRequested: [], nextRescreenAt: new Date((issuedAt + 86400) * 1000).toISOString(), decisionId,
    screenedAt: new Date(issuedAt * 1000).toISOString(),
    attestation: {
      typedData: {
        domain: { name: "CompliR", version: "1", chainId: 5042, verifyingContract: "0x0000000000000000000000000000000000000000" },
        types: { Attestation: [] }, primaryType: "Attestation",
        message: { subject: address as Address, tier: 1, score, decisionHash: "0xabc", issuedAt, validUntil: issuedAt + 86400 },
      },
      signature: "0xsig", attester, validUntil: issuedAt + 86400, registryTx: null,
    },
    evidence: { subject: { address: address as Address, firstSeen: null, txCount: 0, usdcBlacklisted: false, protocolBlocklisted: false, sanctions: [] }, funders: [], lookalikes: [], payeeChanged: null, concentration: null, priorTier: null, collectedAt: issuedAt, depth: 1 },
  };
}
