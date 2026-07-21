import { describe, expect, it } from "vitest";
import { amountInWords, saleInvoiceHtml, saleInvoiceModel, saleInvoicePdfRows } from "../../src/reports";

describe("legal sale invoice", () => {
  it("carries seller and buyer GST, split tax, amount words, and bank details into HTML and PDF data", () => {
    const invoice = saleInvoiceModel(
      { id:7, invoice_number:"INV-7", invoice_date:"2026-07-15", due_date:"2026-08-14", sale_type:"GST", payment_status:"UNPAID", remarks:"EX FACTORY", subtotal_paise:10_000, gst_total_paise:1_800, grand_total_paise:11_800 },
      { code:"FML", name:"Firsttech", gst_number:"27CUSTOMGST" },
      { name:"Buyer", gst_number:"27BUYERGST", address:"Line one\nLine two", city:"Mumbai", state:"Maharashtra" },
      [{ code:"ITM", name:"Tool", unit:"pcs", hsn:"8205", quantity_milliunits:1_000, sale_rate_ten_thousandths:1_000_000, gst_basis_points:1_800, subtotal_paise:10_000, gst_amount_paise:1_800, line_total_paise:11_800 }],
    );
    expect(invoice).toMatchObject({ cgstTotal:900, sgstTotal:900, amountWords:"INR One Hundred Eighteen Only" });
    const html=saleInvoiceHtml(invoice,{saleId:7,autoPrint:true});
    expect(html).toContain("<!doctype html>");
    expect(html).not.toContain("app-shell");
    expect(html).toContain('<main class="sheet">');
    expect(html).toContain('<section class="invoice" aria-label="Tax Invoice INV-7">');
    expect(html).toContain("Description of Goods");
    expect(html).toContain("Amount Chargeable (in words)");
    expect(html).toContain("Company's Bank Details");
    expect(html).toContain("This is a Computer Generated Invoice");
    expect(html).toContain('href="/transactions/sale/7/export/pdf"');
    expect(html).toContain('href="javascript:history.back()"');
    expect(html).toContain('window.addEventListener("load",()=>window.setTimeout(()=>window.print(),250))');
    expect(html).toContain("15-Jul-26");
    expect(html).toContain("Mode/Terms of Payment");
    expect(html).toContain("CREDIT");
    expect(html).toContain("Terms of Delivery");
    expect(html).toContain("EX FACTORY");
    expect(html).toContain("Output CGST @ 9%");
    expect(html).toContain("1 Nos.");
    expect(html).toContain(">Tool</td>");
    expect(html).toContain("27CUSTOMGST");
    expect(html).toContain("27BUYERGST");
    expect(html).toContain("Kotak Mahindra Bank");
    expect(html).toContain("Central Tax");
    expect(saleInvoicePdfRows(invoice).some((row)=>row.Value==="7647407025")).toBe(true);
    expect(amountInWords(12_345_667)).toBe("INR One Lakh Twenty Three Thousand Four Hundred Fifty Six and Sixty Seven Paise Only");
  });

  it("omits auto print and renders a zero-rate tax summary in view mode",()=>{
    const invoice=saleInvoiceModel(
      {id:8,invoice_number:"NON-GST-8",invoice_date:"2026-07-01",payment_status:"PAID",subtotal_paise:5000,gst_total_paise:0,grand_total_paise:5000},
      {code:"AI",name:"Aditya"},
      {name:"Buyer",state:""},
      [{name:"Plain item",unit:"kg",quantity_milliunits:2500,sale_rate_ten_thousandths:200000,gst_basis_points:0,subtotal_paise:5000,gst_amount_paise:0,line_total_paise:5000}],
    );
    const html=saleInvoiceHtml(invoice,{saleId:8});
    expect(html).toContain('<td class="tax-rate">0%</td>');
    expect(html).toContain("100% ADVANCE");
    expect(html).toContain("2.5 Kgs.");
    expect(html).not.toContain("data-auto-print");
    expect(html).not.toContain('window.addEventListener("load"');
  });
});
