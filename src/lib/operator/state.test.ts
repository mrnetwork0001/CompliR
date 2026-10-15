import "../__tests__/setup";
import { describe, it, expect, vi } from "vitest";

// every external source blows up: Arc RPC, Circle, treasury tables, pricing table
vi.mock("../treasury", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../treasury")>();
  return { ...mod, pendingInvoices: vi.fn(async () => { throw new Error("treasury table locked"); }) };
});
vi.mock("../circle", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../circle")>();
  return { ...mod, listStoredWallets: vi.fn(async () => { throw new Error("circle schema failed"); }) };
});
vi.mock("./pricing", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./pricing")>();
  return { ...mod, priceState: vi.fn(async () => { throw new Error("pricing table missing"); }) };
});

import { companySnapshot } from "./state";

describe("companySnapshot never throws", () => {
  it("degrades failed sections to null and names them in errors; healthy sections still populate", async () => {
    process.env.REVENUE_WALLET = "0x00000000000000000000000000000000000000aa"; // forces a chain read against the unreachable RPC
    const s = await companySnapshot();
    expect(s.asOf).toMatch(/T/);
    expect(s.obligations).toBeNull();
    expect(s.errors.obligations).toMatch(/treasury table locked/);
    expect(s.pricing).toBeNull();
    expect(s.errors.pricing).toMatch(/pricing table missing/);
    // reserves: chain read fails (unreachable RPC) and Circle fails → still an object, with nulls + reasons
    expect(s.reserves).not.toBeNull();
    expect(s.reserves!.floatUsdc).toBeNull();
    expect(s.reserves!.error).toBeTruthy();
    expect(s.reserves!.error).not.toMatch(/URL:|Request body|Raw Call/); // short public text, never the RPC dump
    expect(s.reserves!.circle.enabled).toBe(false);
    expect(s.reserves!.circle.reason).toMatch(/circle schema failed/);
    // DB-backed sections that did not fail are populated
    expect(s.revenue).toMatchObject({ totalUsdc: 0, callsPaid: 0, payers: 0 });
    expect(s.screening).toMatchObject({ screenings24h: 0, watchesActive: 0, p95LatencyMs: null });
    expect(s.mode).toMatchObject({ treasury: "dry-run", yield: "dry", yieldBackend: "earn", x402: "disabled", paused: false });
  }, 30_000);
});

describe("friendlyError / withRateLimitRetry (public Company page text)", async () => {
  const { friendlyError, withRateLimitRetry } = await import("./state");
  const viemDump = Object.assign(new Error(
    'HTTP request failed.\n\nURL: https://rpc.mainnet.arc.io\nRequest body: {"method":"eth_call","params":[{"data":"0x70a0823100"}]}\n\nRaw Call Arguments:\n  to: 0x3600\nDocs: https://viem.sh\nDetails: rate limit exceeded\nVersion: viem@2.57.4',
  ), { details: "rate limit exceeded" });

  it("names a rate limit instead of dumping the RPC request", () => {
    const t = friendlyError(viemDump);
    expect(t).toBe("Arc RPC rate limit; retrying shortly");
    expect(t).not.toMatch(/Request body|Raw Call|0x70a08231/);
  });

  it("cuts other viem errors to their first line, max 120 chars", () => {
    expect(friendlyError(new Error("Execution reverted.\n\nURL: https://x\nRequest body: {}"))).toBe("Execution reverted.");
    expect(friendlyError(new Error("x".repeat(300))).length).toBe(120);
  });

  it("retries rate-limited reads, then succeeds; other errors throw at once", async () => {
    let n = 0;
    const v = await withRateLimitRetry(async () => { if (++n < 3) throw viemDump; return 42; }, [1, 1]);
    expect(v).toBe(42);
    expect(n).toBe(3);
    let m = 0;
    await expect(withRateLimitRetry(async () => { m++; throw new Error("boom"); }, [1, 1])).rejects.toThrow("boom");
    expect(m).toBe(1);
  });
});
