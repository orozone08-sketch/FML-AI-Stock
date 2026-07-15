import { describe, expect, it } from "vitest";
import { allocatePayment, money, reverseAllocations } from "../../src/domain";

describe("payment allocation parity", () => {
  const rows = [
    { id: 2, companyId: 1, partyId: 7, dueDate: "2026-02-01", documentDate: "2026-01-02", total: money("100"), paid: money("0") },
    { id: 1, companyId: 1, partyId: 7, dueDate: "2026-01-01", documentDate: "2026-01-01", total: money("50"), paid: money("10") },
  ];
  it("allocates preferred document first then oldest outstanding", () => {
    const result = allocatePayment(money("75"), 1, 7, rows, 2);
    expect(result.allocations).toEqual([{ targetId: 2, amount: 7500n }]);
    expect(result.unallocated).toBe(0n);
    expect(reverseAllocations(result.outstandings, result.allocations)).toEqual(rows);
  });
  it("allocates oldest first without an explicit target and preserves advances", () => {
    const result = allocatePayment(money("200"), 1, 7, rows);
    expect(result.allocations).toEqual([{ targetId: 1, amount: 4000n }, { targetId: 2, amount: 10000n }]);
    expect(result.unallocated).toBe(6000n);
  });
  it("rejects a selected cross-company document", () => {
    expect(() => allocatePayment(money("1"), 2, 7, rows, 1)).toThrow(/different company/);
  });
});
