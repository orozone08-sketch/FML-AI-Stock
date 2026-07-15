import { describe, expect, it } from "vitest";
import { amountInWords, saleInvoiceHtml, saleInvoiceModel, saleInvoicePdfRows } from "../../src/reports";

describe("legal sale invoice", () => {
  it("carries seller and buyer GST, split tax, amount words, and bank details into HTML and PDF data", () => {
    const invoice = saleInvoiceModel(
      { invoice_number:"INV-7", invoice_date:"2026-07-15", due_date:"2026-08-14", sale_type:"GST", subtotal_paise:10_000, gst_total_paise:1_800, grand_total_paise:11_800 },
      { code:"FML", name:"Firsttech", gst_number:"27CUSTOMGST" },
      { name:"Buyer", gst_number:"27BUYERGST", address:"Line one\nLine two", city:"Mumbai", state:"Maharashtra" },
      [{ code:"ITM", name:"Tool", unit:"pcs", hsn:"8205", quantity_milliunits:1_000, sale_rate_ten_thousandths:1_000_000, gst_basis_points:1_800, subtotal_paise:10_000, gst_amount_paise:1_800, line_total_paise:11_800 }],
    );
    expect(invoice).toMatchObject({ cgstTotal:900, sgstTotal:900, amountWords:"INR One Hundred Eighteen Only" });
    const html=saleInvoiceHtml(invoice);
    expect(html).toContain("27CUSTOMGST");
    expect(html).toContain("27BUYERGST");
    expect(html).toContain("Kotak Mahindra Bank");
    expect(html).toContain("CGST rate");
    expect(saleInvoicePdfRows(invoice).some((row)=>row.Value==="7647407025")).toBe(true);
    expect(amountInWords(12_345_667)).toBe("INR One Lakh Twenty Three Thousand Four Hundred Fifty Six and Sixty Seven Paise Only");
  });
});
