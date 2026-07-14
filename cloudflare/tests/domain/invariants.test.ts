import { describe, expect, it } from "vitest";
import { assertDocumentPaymentInvariant, assertFifoInvariant, assertInventoryInvariant, assertPaymentInvariant, deterministicPlan, money, quantity } from "../../src/domain";

describe("write-plan safeguards", () => {
  it("checks ledger, FIFO, document and payment equations", () => {
    expect(() => assertPaymentInvariant(money("10"), money("6"), money("4"))).not.toThrow();
    expect(() => assertDocumentPaymentInvariant(money("10"), money("6"), money("3"))).toThrow();
    expect(() => assertFifoInvariant(quantity("5"), quantity("2"), quantity("3"))).not.toThrow();
    expect(() => assertInventoryInvariant(quantity("-1"), [{ quantityIn: quantity("2"), quantityOut: quantity("3") }])).not.toThrow();
  });
  it("makes command ordering explicit and rejects duplicate mutation identities", () => {
    expect(deterministicPlan("sale.create", "key", [{ key: "sale", sql: "INSERT", params: [] }]).mutations[0]!.key).toBe("sale");
    expect(() => deterministicPlan("sale.create", "key", [{ key: "x", sql: "A", params: [] }, { key: "x", sql: "B", params: [] }])).toThrow(/unique/);
  });
});
