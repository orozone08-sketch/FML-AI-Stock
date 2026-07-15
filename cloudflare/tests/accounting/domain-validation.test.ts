import { describe, expect, it } from "vitest";
import { assertDocumentLineCount, assertPaymentContext, assertSaleContext, assertTransferContext } from "../../src/accounting/domain-validation";

class Statement {
  params: unknown[] = [];
  constructor(private readonly query: string) {}
  bind(...params: unknown[]) { this.params = params; return this; }
  first<T>() {
    if (this.query.includes("FROM companies fc JOIN stock_books")) return Promise.resolve((this.params[0] === 2 && this.params[1] === 1 && this.params[2] === 2 && this.params[3] === 6 ? { from_type: "GST", to_type: "CASH" } : null) as T);
    if (this.query.includes("FROM companies c JOIN stock_books")) return Promise.resolve((this.params[0] === 1 && this.params[1] === 2 ? { book_type: "GST", allow_gst_purchase: 1, allow_cash_purchase: 0, allow_gst_sale: 1, allow_cash_sale: 0 } : null) as T);
    if (this.query.includes("FROM companies")) return Promise.resolve((this.params[0] === 1 ? { id: 1 } : null) as T);
    if (this.query.includes("FROM stock_books")) return Promise.resolve((this.params[0] === 2 && this.params[1] === 1 ? { id: 2 } : null) as T);
    if (this.query.includes("FROM customers")) return Promise.resolve((this.params[0] === 3 ? { id: 3 } : null) as T);
    if (this.query.includes("FROM suppliers")) return Promise.resolve((this.params[0] === 9 ? { id: 9 } : null) as T);
    if (this.query.includes("FROM payment_modes")) return Promise.resolve((this.params[0] === "BANK" ? { id: 1 } : null) as T);
    if (this.query.includes("FROM items")) return Promise.resolve(({ count: this.params.every((id) => id === 4 || id === 5) ? new Set(this.params).size : 0 } as unknown) as T);
    return Promise.resolve(null as T);
  }
}
class Db { prepare(query: string) { return new Statement(query); } }
const db = new Db() as unknown as D1Database;

describe("accounting domain validation", () => {
  it("bounds document lines before a request can create an oversized D1 batch", () => {
    expect(() => assertDocumentLineCount(0)).toThrow(/At least one/);
    expect(() => assertDocumentLineCount(100)).not.toThrow();
    expect(() => assertDocumentLineCount(101)).toThrow(/at most 100/);
  });

  it("accepts only active masters in the selected company", async () => {
    await expect(assertSaleContext(db, { companyId: 1, stockBookId: 2, customerId: 3, documentType: "GST", itemIds: [4, 5] })).resolves.toBeUndefined();
    await expect(assertSaleContext(db, { companyId: 1, stockBookId: 99, customerId: 3, documentType: "GST", itemIds: [4] })).rejects.toThrow(/Company or stock book/);
    await expect(assertSaleContext(db, { companyId: 1, stockBookId: 2, customerId: 99, documentType: "GST", itemIds: [4] })).rejects.toThrow(/Customer/);
    await expect(assertSaleContext(db, { companyId: 1, stockBookId: 2, customerId: 3, documentType: "GST", itemIds: [99] })).rejects.toThrow(/items/);
    await expect(assertSaleContext(db, { companyId: 1, stockBookId: 2, customerId: 3, documentType: "CASH", itemIds: [4] })).rejects.toThrow(/stock book/);
  });

  it("rejects inactive payment parties and modes before allocation reads", async () => {
    await expect(assertPaymentContext(db, { companyId: 1, partyId: 9, customer: false, mode: "BANK" })).resolves.toBeUndefined();
    await expect(assertPaymentContext(db, { companyId: 1, partyId: 9, customer: false, mode: "CASH" })).rejects.toThrow(/Payment mode/);
    await expect(assertPaymentContext(db, { companyId: 1, partyId: 99, customer: false, mode: "BANK" })).rejects.toThrow(/Supplier/);
  });

  it("requires explicit approval when a transfer crosses GST and CASH books",async()=>{
    const input={companyId:1,stockBookId:2,toCompanyId:2,toStockBookId:6,itemIds:[4]};
    await expect(assertTransferContext(db,input)).rejects.toThrow(/requires approval/);
    await expect(assertTransferContext(db,{...input,mismatchApproved:true})).resolves.toBeUndefined();
  });
});
