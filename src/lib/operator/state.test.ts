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
    expect(s.reserves!.error).toMatch(/chain read failed/);
    expect(s.reserves!.circle.enabled).toBe(false);
    expect(s.reserves!.circle.reason).toMatch(/circle schema failed/);
    // DB-backed sections that did not fail are populated
    expect(s.revenue).toMatchObject({ totalUsdc: 0, callsPaid: 0, payers: 0 });
    expect(s.screening).toMatchObject({ screenings24h: 0, watchesActive: 0, p95LatencyMs: null });
    expect(s.mode).toMatchObject({ treasury: "dry-run", yield: "dry", yieldBackend: "earn", x402: "disabled", paused: false });
  }, 30_000);
});
