import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseAddress, parseJson, parseLimit } from "./parse";
import { ApiError, handle } from "./respond";

describe("parseLimit", () => {
  const url = (q: string) => new URL(`http://x/api/v1/feed${q}`);
  it("defaults, clamps and rejects junk", () => {
    expect(parseLimit(url(""), { def: 25, max: 100 })).toBe(25);
    expect(parseLimit(url("?limit=500"), { def: 25, max: 100 })).toBe(100);
    expect(parseLimit(url("?limit=7"))).toBe(7);
    expect(() => parseLimit(url("?limit=0"))).toThrow(ApiError);
    expect(() => parseLimit(url("?limit=abc"))).toThrow(ApiError);
  });
});

describe("parseAddress", () => {
  it("lowercases valid and rejects invalid", () => {
    expect(parseAddress("0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD")).toBe("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    expect(() => parseAddress("0x123")).toThrow(ApiError);
    expect(() => parseAddress(undefined)).toThrow(ApiError);
  });
});

describe("parseJson + handle", () => {
  const schema = z.object({ n: z.number() });
  it("treats empty body as {} and reports zod issues as 400", async () => {
    const res = await handle(async (req) => Response.json(await parseJson(req, schema)))(new Request("http://x", { method: "POST", body: "" }), {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details.issues[0].path).toBe("n");
  });
  it("rejects invalid JSON with INVALID_JSON", async () => {
    const res = await handle(async (req) => Response.json(await parseJson(req, schema)))(new Request("http://x", { method: "POST", body: "{nope" }), {});
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_JSON");
  });
  it("passes valid bodies through and sets base headers", async () => {
    const res = await handle(async (req) => Response.json(await parseJson(req, schema)))(new Request("http://x", { method: "POST", body: JSON.stringify({ n: 3 }) }), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ n: 3 });
  });
  it("turns unknown errors into 500 INTERNAL_ERROR", async () => {
    const res = await handle(async () => {
      throw new Error("boom");
    })(new Request("http://x"), {});
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL_ERROR");
  });
});
