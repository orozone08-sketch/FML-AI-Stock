import { describe, expect, it } from "vitest";
import { applyGst, checkedD1Integer, gstRate, lineTotals, money, quantity, rate } from "../../src/domain";

describe("scaled accounting values", () => {
  it("matches Decimal ROUND_HALF_UP including negative ties", () => {
    expect(money("1.005")).toBe(101n);
    expect(money("-1.005")).toBe(-101n);
    expect(quantity("1.2345")).toBe(1235n);
    expect(rate("12.34567")).toBe(123457n);
  });
  it("calculates line and GST totals without floating point", () => {
    expect(lineTotals(quantity("2.500"), rate("99.9999"), gstRate("18"))).toEqual({ subtotal: 25000n, gst: 4500n, total: 29500n });
    expect(applyGst(money("0.03"), gstRate("18"))).toBe(1n);
  });
  it("rejects values D1 cannot safely round-trip through JS", () => {
    expect(() => checkedD1Integer(9_007_199_254_740_992n)).toThrow(/safe integer/);
  });
});
