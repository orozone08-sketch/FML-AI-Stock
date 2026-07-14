import { describe, expect, it } from "vitest";
import { consumePendingLots, pendingTransferLots, quantity, rate } from "../../src/domain";

describe("pending transfer lots", () => {
  const facts = [
    { id: 1, date: "2026-01-01", fromCompanyId: 1, toCompanyId: 2, direction: "ISSUE" as const, quantity: quantity("2"), rate: rate("120") },
    { id: 2, date: "2026-01-02", fromCompanyId: 1, toCompanyId: 2, direction: "ISSUE" as const, quantity: quantity("2"), rate: rate("150") },
    { id: 3, date: "2026-01-03", fromCompanyId: 2, toCompanyId: 1, direction: "RETURN" as const, quantity: quantity("1"), rate: rate("0") },
  ];
  it("subtracts returns FIFO and costs new returns from pending issue lots", () => {
    const lots = pendingTransferLots(1, 2, facts);
    expect(lots.map((lot) => lot.quantity)).toEqual([1000n, 2000n]);
    expect(consumePendingLots(lots, quantity("2")).totalValue).toBe(27000n);
  });
  it("does not permit a return beyond pending quantity", () => {
    expect(() => consumePendingLots(pendingTransferLots(1, 2, facts), quantity("4"))).toThrow(/Cannot return more stock/);
  });
});
