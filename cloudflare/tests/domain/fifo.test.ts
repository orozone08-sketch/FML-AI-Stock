import { describe, expect, it } from "vitest";
import { allocateFifo, quantity, rate, restoreFifo } from "../../src/domain";

describe("FIFO parity", () => {
  const layers = [
    { id: 2, sourceDate: "2026-01-02", availableQuantity: quantity("3"), unitCost: rate("120") },
    { id: 1, sourceDate: "2026-01-01", availableQuantity: quantity("2"), unitCost: rate("100") },
  ];
  it("allocates oldest first and leaves an intentional zero-cost negative remainder", () => {
    const result = allocateFifo(quantity("7"), layers);
    expect(result.consumptions.map((row) => [row.layerId, row.quantity, row.value])).toEqual([[1, 2000n, 20000n], [2, 3000n, 36000n], [null, 2000n, 0n]]);
    expect(result.coveredCost).toBe(56000n);
    expect(result.shortage).toBe(2000n);
  });
  it("restores persisted consumptions but ignores the synthetic shortage", () => {
    const allocated = allocateFifo(quantity("6"), layers);
    expect(restoreFifo(allocated.layers, allocated.consumptions).map((row) => row.availableQuantity)).toEqual([2000n, 3000n]);
  });
});
