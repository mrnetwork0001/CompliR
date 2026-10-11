import { afterEach, describe, expect, it, vi } from "vitest";
import { screenAddresses, screenSanctions, yenteMatch } from "./yente";

const addr = "0x000000000000000000000000000000000000dead" as const;
const jsonRes = (body: unknown, status = 200) =>
  ({ ok: status < 300, status, json: async () => body }) as unknown as Response;

afterEach(() => vi.restoreAllMocks());

describe("yente", () => {
  it("returns [] when yente is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await screenSanctions({ address: addr, name: "Any Name" }, { baseUrl: "http://127.0.0.1:1", fetchImpl })).toEqual([]);
  });

  it("returns [] on non-2xx, malformed JSON and timeouts", async () => {
    expect(await screenSanctions({ address: addr }, { baseUrl: "http://y", fetchImpl: vi.fn(async () => jsonRes({ detail: "x" }, 503)) as never })).toEqual([]);
    const bad = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } })) as never;
    expect(await screenSanctions({ address: addr }, { baseUrl: "http://y", fetchImpl: bad })).toEqual([]);
    const slow = vi.fn((_: string, init?: RequestInit) => new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as never;
    expect(await screenSanctions({ address: addr }, { baseUrl: "http://y", fetchImpl: slow, timeoutMs: 20 })).toEqual([]);
  });

  it("posts CryptoWallet.publicKey + Person/Company/LegalEntity name queries and maps hits", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://y/match/default?threshold=0.7&limit=5");
      const body = JSON.parse(String(init?.body));
      expect(body.queries["a:0"]).toEqual({ schema: "CryptoWallet", properties: { publicKey: [addr, "0x000000000000000000000000000000000000dEaD"] } });
      expect(Object.keys(body.queries).sort()).toEqual(["a:0", "n:0:Company", "n:0:LegalEntity", "n:0:Person"]);
      return jsonRes({
        responses: {
          "a:0": { status: 200, results: [{ id: "NK-1", caption: "Bad Wallet", datasets: ["us_ofac_sdn"], score: 1, match: true }] },
          "n:0:Person": {
            status: 200,
            results: [
              { id: "NK-1", caption: "Bad Wallet", datasets: ["us_ofac_sdn"], score: 0.75, match: true }, // dup of the address hit
              { id: "NK-2", caption: "Bad Person", datasets: ["eu_fsf"], score: 0.9, match: true },
              { id: "NK-3", caption: "Weak", datasets: ["x"], score: 0.4, match: false }, // below threshold
            ],
          },
          "n:0:Company": { status: 200, results: [] },
          "n:0:LegalEntity": { status: 200, results: [{ id: "NK-2", caption: "Bad Person", datasets: ["eu_fsf"], score: 0.8, match: true }] },
        },
      });
    }) as unknown as typeof fetch;
    const hits = await screenSanctions({ address: addr, name: "Bad Person" }, { baseUrl: "http://y/", dataset: "default", threshold: 0.7, fetchImpl });
    expect(hits).toEqual([
      { source: "opensanctions", entityId: "NK-1", caption: "Bad Wallet", datasets: ["us_ofac_sdn"], score: 1, matchedOn: "address" },
      { source: "opensanctions", entityId: "NK-2", caption: "Bad Person", datasets: ["eu_fsf"], score: 0.9, matchedOn: "name" },
    ]);
  });

  it("screenAddresses batches many wallets in one request keyed by index", async () => {
    const a1 = "0x00000000000000000000000000000000000000a1" as const;
    const a2 = "0x00000000000000000000000000000000000000a2" as const;
    const fetchImpl = vi.fn(async (_: string, init?: RequestInit) => {
      const q = JSON.parse(String(init?.body)).queries;
      expect(Object.keys(q)).toEqual(["a:0", "a:1"]);
      return jsonRes({ responses: { "a:1": { results: [{ id: "NK-9", caption: "Hit", datasets: [], score: 0.95, match: true }] } } });
    }) as unknown as typeof fetch;
    const m = await screenAddresses([a1, a2, a1], { baseUrl: "http://y", fetchImpl });
    expect(m.get(a1)).toEqual([]);
    expect(m.get(a2)?.[0].entityId).toBe("NK-9");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when there is nothing to query", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await yenteMatch([{ name: "  " }], { baseUrl: "http://y", fetchImpl })).toEqual([[]]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
