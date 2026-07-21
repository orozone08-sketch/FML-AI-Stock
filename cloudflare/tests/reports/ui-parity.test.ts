import { describe, expect, it } from "vitest";
import { reportTable, reportToolbar } from "../../src/routes/reports";

const context = (values: Record<string, string> = {}) => ({
  req: { query: (name: string) => values[name] },
});

describe("report UI parity", () => {
  it("renders the Flask toolbar contract and keeps filters in export links", () => {
    const query = new URLSearchParams("q=gold&date_from=2026-07-01&cursor_id=9");
    const html = reportToolbar(context({ q: "gold", date_from: "2026-07-01" }), "sales", query, true);
    expect(html).toContain('class="toolbar"');
    expect(html).toContain('data-live-search-form');
    expect(html).toContain('data-live-target="#report_table"');
    for (const label of ["All reports", "Find", "CSV", "XLSX", "PDF", "Print"]) expect(html).toContain(label);
    expect(html).toContain("q=gold");
    expect(html).not.toContain("cursor_id=9");
  });

  it("renders selectable report rows, empty feedback, and sale actions", () => {
    const html = reportTable("sales", ["Date", "Invoice"], [["2026-07-21", "INV-1"]], [{ id: 7 }]);
    expect(html).toContain('id="report_table"');
    expect(html).toContain('data-selectable-rows');
    expect(html).toContain('data-row-key="sales-1"');
    expect(html).toContain("/transactions/sale/7/view");
    expect(html).toContain("No matching rows.");
  });

  it("uses the Flask item-ledger picker and scoped company/book controls", () => {
    const html = reportToolbar(
      context({ item_id: "3", stock_book_id: "8" }),
      "item-ledger",
      new URLSearchParams("item_id=3&stock_book_id=8"),
      true,
      {
        activeCompanyId: 1,
        companies: [{ id: 1, code: "AI", name: "Aditya" }],
        items: [{ id: 3, code: "RING", name: "Ring" }],
        books: [{ id: 8, code: "GST", name: "GST Stock" }],
      },
    );
    expect(html).toContain("data-option-picker");
    expect(html).toContain('data-option-id="3"');
    expect(html).toContain('name="company_id" value="1"');
    expect(html).toContain('<option value="8" selected>GST - GST Stock</option>');
  });
});
