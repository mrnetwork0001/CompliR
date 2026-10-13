import "@/lib/__tests__/setup";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/store/db";
import { ensurePayLinksTable, paymentUri, toNativeUnits } from "@/lib/paylinks";
import { POST as create } from "./route";
import { GET as read } from "./[id]/route";
import { POST as screenRoute } from "./[id]/screen/route";
import { POST as decide } from "./[id]/decide/route";

const MERCHANT = "0xc742ada2872a042dd36d2e706907b4036968960c";
const PAYER = "0x000000000000000000000000000000000000d00d";
const json = (url: string, body: unknown, method = "POST") => new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => { await ensurePayLinksTable(); });

describe("pay links", () => {
  it("EIP-681 uri uses native 18-dp units", () => {
    expect(toNativeUnits(25)).toBe("25000000000000000000");
    expect(toNativeUnits(0.000001)).toBe("1000000000000");
    expect(toNativeUnits(1.5)).toBe("1500000000000000000");
    expect(paymentUri(MERCHANT, 2.5, 5042)).toBe(`ethereum:${MERCHANT}@5042?value=2500000000000000000`);
  });

  it("create → screen → decide lifecycle", async () => {
    const r1 = await create(json("/api/v1/pay", { merchant: "Acme", to: MERCHANT, amountUsdc: 12.5, memo: "inv 7" }), {});
    expect(r1.status).toBe(201);
    const c = await r1.json();
    expect(c.id).toMatch(/^pay_[0-9a-f]{12}$/);
    expect(c.url).toContain(`/pay/${c.id}`);
    expect(c.merchantKey).toMatch(/^mk_/);
    expect(c.link.status).toBe("OPEN");
    expect(c.link.paymentUri).toBeNull();

    // public view never leaks the key or score
    const pub = await (await read(new Request(`http://localhost/api/v1/pay/${c.id}`), ctx(c.id))).json();
    expect(pub.merchantKey).toBeUndefined(); expect(pub.merchantUrl).toBeUndefined(); expect(pub.payerScore).toBeUndefined();
    expect((await read(new Request(`http://localhost/api/v1/pay/${c.id}?key=mk_wrong`), ctx(c.id))).status).toBe(403);

    // decide before screening → 409
    expect((await decide(json(`/api/v1/pay/${c.id}/decide`, { key: c.merchantKey, action: "accept" }), ctx(c.id))).status).toBe(409);

    // payer screens (mock evidence → some tier)
    const s = await screenRoute(json(`/api/v1/pay/${c.id}/screen`, { from: PAYER }), ctx(c.id));
    expect(s.status).toBe(200);
    const sv = await s.json();
    expect(sv.payerAddress).toBe(PAYER);
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(sv.payerTier);
    expect(sv.payerDecisionId).toMatch(/^dec_/);
    if (sv.payerTier === "HIGH") { expect(sv.status).toBe("DECLINED"); expect(sv.paymentUri).toBeNull(); return; }
    expect(sv.status).toBe("SCREENED");
    if (sv.payerTier === "LOW") expect(sv.paymentUri).toBe(`ethereum:${MERCHANT}@5042?value=12500000000000000000`);
    else expect(sv.paymentUri).toBeNull();

    // merchant view shows the score; wrong key cannot decide
    const mv = await (await read(new Request(`http://localhost/api/v1/pay/${c.id}?key=${c.merchantKey}`), ctx(c.id))).json();
    expect(typeof mv.payerScore).toBe("number");
    expect((await decide(json(`/api/v1/pay/${c.id}/decide`, { key: "mk_" + "0".repeat(32), action: "accept" }), ctx(c.id))).status).toBe(403);

    const d = await (await decide(json(`/api/v1/pay/${c.id}/decide`, { key: c.merchantKey, action: "accept" }), ctx(c.id))).json();
    expect(d.status).toBe("ACCEPTED");
    expect(d.paymentUri).toContain("ethereum:");
    // cannot re-screen or re-decide once accepted
    expect((await screenRoute(json(`/api/v1/pay/${c.id}/screen`, { from: PAYER }), ctx(c.id))).status).toBe(409);
    expect((await decide(json(`/api/v1/pay/${c.id}/decide`, { key: c.merchantKey, action: "decline" }), ctx(c.id))).status).toBe(409);
  });

  it("decline path", async () => {
    const c = await (await create(json("/api/v1/pay", { merchant: "Acme", to: MERCHANT, amountUsdc: 1 }), {})).json();
    const sv = await (await screenRoute(json(`/api/v1/pay/${c.id}/screen`, { from: PAYER }), ctx(c.id))).json();
    if (sv.status !== "SCREENED") return;
    const d = await (await decide(json(`/api/v1/pay/${c.id}/decide`, { key: c.merchantKey, action: "decline" }), ctx(c.id))).json();
    expect(d.status).toBe("DECLINED"); expect(d.paymentUri).toBeNull();
  });

  it("expires lazily and refuses screening afterwards", async () => {
    const c = await (await create(json("/api/v1/pay", { merchant: "Acme", to: MERCHANT, amountUsdc: 1, expiresInHours: 1 }), {})).json();
    await db().execute({ sql: "UPDATE pay_links SET expires_at = ? WHERE id = ?", args: [Math.floor(Date.now() / 1000) - 10, c.id] });
    const pub = await (await read(new Request(`http://localhost/api/v1/pay/${c.id}`), ctx(c.id))).json();
    expect(pub.status).toBe("EXPIRED");
    expect((await screenRoute(json(`/api/v1/pay/${c.id}/screen`, { from: PAYER }), ctx(c.id))).status).toBe(409);
  });

  it("validates input and blocks cross-site browser posts", async () => {
    expect((await create(json("/api/v1/pay", { merchant: "", to: "nope", amountUsdc: -1 }), {})).status).toBe(400);
    expect((await read(new Request("http://localhost/api/v1/pay/pay_000000000000"), ctx("pay_000000000000"))).status).toBe(404);
    const cross = new Request("http://localhost/api/v1/pay", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: "{}" });
    expect((await create(cross, {})).status).toBe(403);
  });
});
