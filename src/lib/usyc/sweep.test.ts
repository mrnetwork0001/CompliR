import "../__tests__/setup";
import { describe, it, expect } from "vitest";
import { planSweep, usycEnv, USYC_DEFAULTS } from "./sweep";

describe("planSweep", () => {
  it("deposits the excess above the float", () => {
    expect(planSweep({ balanceUsdc: 12.5, floatUsdc: 5, minSweepUsdc: 1 })).toMatchObject({ action: "DEPOSIT", amount: 7.5 });
  });
  it("does nothing when the excess is below the minimum sweep", () => {
    expect(planSweep({ balanceUsdc: 5.5, floatUsdc: 5, minSweepUsdc: 1 }).action).toBe("NONE");
    expect(planSweep({ balanceUsdc: 5, floatUsdc: 5, minSweepUsdc: 1 }).action).toBe("NONE");
    expect(planSweep({ balanceUsdc: 0, floatUsdc: 5, minSweepUsdc: 1 }).action).toBe("NONE");
  });
  it("deposits exactly at the threshold", () => {
    expect(planSweep({ balanceUsdc: 6, floatUsdc: 5, minSweepUsdc: 1 })).toMatchObject({ action: "DEPOSIT", amount: 1 });
  });
  it("redeems the shortfall when USYC is available, capped at the holding", () => {
    expect(planSweep({ balanceUsdc: 1, floatUsdc: 5, minSweepUsdc: 1, usycUsdc: 100 })).toMatchObject({ action: "REDEEM", amount: 4 });
    expect(planSweep({ balanceUsdc: 1, floatUsdc: 5, minSweepUsdc: 1, usycUsdc: 2.5 })).toMatchObject({ action: "REDEEM", amount: 2.5 });
    expect(planSweep({ balanceUsdc: 1, floatUsdc: 5, minSweepUsdc: 1, usycUsdc: 0 }).action).toBe("NONE");
    expect(planSweep({ balanceUsdc: 4.5, floatUsdc: 5, minSweepUsdc: 1, usycUsdc: 100 }).action).toBe("NONE");
  });
  it("rounds to 6 dp and tolerates garbage", () => {
    const p = planSweep({ balanceUsdc: 5.1234567, floatUsdc: 0, minSweepUsdc: 0.5 });
    expect(p.amount).toBe(5.123457);
    expect(planSweep({ balanceUsdc: NaN, floatUsdc: 5, minSweepUsdc: 1 }).action).toBe("NONE");
    expect(planSweep({ balanceUsdc: -3, floatUsdc: 5, minSweepUsdc: 1 }).action).toBe("NONE");
  });
  it("zero float sweeps everything", () => {
    expect(planSweep({ balanceUsdc: 0.75, floatUsdc: 0, minSweepUsdc: 0.5 })).toMatchObject({ action: "DEPOSIT", amount: 0.75 });
  });
});

describe("usycEnv", () => {
  it("defaults to dry-run with mainnet addresses and 5/1 thresholds", () => {
    delete process.env.USYC_MODE; delete process.env.REVENUE_PRIVATE_KEY; delete process.env.USYC_FLOAT_USDC; delete process.env.USYC_MIN_SWEEP_USDC;
    const e = usycEnv();
    expect(e.mode).toBe("dry");
    expect(e.usyc).toBe(USYC_DEFAULTS[5042].usyc);
    expect(e.teller).toBe(USYC_DEFAULTS[5042].teller);
    expect(e.floatUsdc).toBe(5); expect(e.minSweepUsdc).toBe(1);
    expect(e.hasKey).toBe(false);
  });
});
