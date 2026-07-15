/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { amountInWords, ReportRepository, saleInvoiceHtml, saleInvoiceModel, saleInvoicePdfRows } from "../../src/reports";

declare global {
  namespace Cloudflare {
    interface Env { DB: D1Database }
  }
}

const migrations=import.meta.glob("../../migrations/*.sql",{query:"?raw",import:"default",eager:true}) as Record<string,string>;

let databasePromise:Promise<D1Database>|undefined;
function database(){
  return databasePromise??=initializeDatabase();
}

async function initializeDatabase(){
  const db=env.DB;
  for(const sourceRaw of Object.entries(migrations).sort(([left],[right])=>left.localeCompare(right)).map(([,source])=>source)){
    const source=sourceRaw.replaceAll("\r","");
    for(const statement of source.split(";").map(value=>value.trim()).filter(Boolean))await db.prepare(statement).run();
  }
  const t="2026-07-15T00:00:00.000Z";
  const statements=[
    "INSERT INTO companies(id,name,code,gst_number,active,created_at,updated_at) VALUES(1,'Firsttech','FML','27AAIFF5739P1ZO',1,?,?),(2,'Aditya','AI',NULL,1,?,?)",
    "INSERT INTO stock_books(id,company_id,name,code,book_type,active,created_at,updated_at) VALUES(1,1,'FML GST','FML-GST','GST',1,?,?),(2,2,'AI GST','AI-GST','GST',1,?,?)",
    "INSERT INTO items(id,code,name,unit,hsn,gst_basis_points,active,created_at,updated_at) VALUES(1,'ITM-1','Tool','pcs','8205',1800,1,?,?)",
    "INSERT INTO customers(id,code,name,customer_type,active,created_at,updated_at) VALUES(1,'CUS-1','Buyer One','BILL',1,?,?)",
    "INSERT INTO suppliers(id,code,name,active,created_at,updated_at) VALUES(1,'SUP-1','Supplier One',1,?,?),(2,'SUP-2','Supplier Two',1,?,?)",
    "INSERT INTO receivables(id,company_id,customer_id,source_type,source_id,document_number,document_date,due_date,total_amount_paise,paid_amount_paise,balance_amount_paise,payment_status,created_at,updated_at) VALUES(1,1,1,'SALE',1,'INV-1','2026-07-01','2026-07-10',10000,2000,8000,'PARTIAL',?,?),(2,1,1,'SALE',2,'INV-2','2026-07-02','2026-07-11',5000,0,5000,'UNPAID',?,?)",
    "INSERT INTO payables(id,company_id,supplier_id,source_type,source_id,document_number,document_date,due_date,total_amount_paise,paid_amount_paise,balance_amount_paise,payment_status,created_at,updated_at) VALUES(1,1,1,'PURCHASE',1,'BILL-1','2026-07-01','2026-07-10',9000,1000,8000,'PARTIAL',?,?)",
    "INSERT INTO payments(id,company_id,payment_type,party_type,customer_id,payment_date,mode,reference_number,total_amount_paise,allocated_amount_paise,unallocated_amount_paise,created_at,updated_at) VALUES(1,1,'CUSTOMER_RECEIPT','CUSTOMER',1,'2026-07-03','BANK','RCPT-1',3000,0,3000,?,?),(2,1,'OPENING_ADVANCE_RECEIVED','CUSTOMER',1,'2026-04-01','CASH','OPEN-C',500,0,500,?,?)",
    "INSERT INTO payments(id,company_id,payment_type,party_type,supplier_id,payment_date,mode,reference_number,total_amount_paise,allocated_amount_paise,unallocated_amount_paise,created_at,updated_at) VALUES(3,1,'OPENING_ADVANCE_PAID','SUPPLIER',1,'2026-04-01','CASH','OPEN-S',1000,0,1000,?,?)",
    "INSERT INTO purchases(id,company_id,stock_book_id,supplier_id,purchase_type,bill_number,bill_date,subtotal_paise,gst_total_paise,grand_total_paise,paid_amount_paise,balance_amount_paise,payment_status,created_at,updated_at) VALUES(1,1,1,1,'GST','P-OLD','2026-06-01',1000,0,1000,0,1000,'UNPAID',?,?),(2,1,1,1,'GST','P-NEW','2026-07-01',1200,0,1200,0,1200,'UNPAID',?,?),(3,1,1,2,'GST','P-ONLY','2026-07-02',1500,0,1500,0,1500,'UNPAID',?,?)",
    "INSERT INTO purchase_lines(id,purchase_id,item_id,quantity_milliunits,rate_ten_thousandths,gst_basis_points,subtotal_paise,gst_amount_paise,line_total_paise) VALUES(1,1,1,1000,10000,0,1000,0,1000),(2,2,1,1000,12000,0,1200,0,1200),(3,3,1,1000,15000,0,1500,0,1500)",
    "INSERT INTO sales(id,company_id,stock_book_id,customer_id,sale_type,invoice_number,invoice_date,subtotal_paise,gst_total_paise,grand_total_paise,fifo_cost_paise,gross_profit_paise,paid_amount_paise,balance_amount_paise,payment_status,created_at,updated_at) VALUES(1,1,1,1,'GST','S-OLD','2026-06-01',2000,0,2000,1000,1000,0,2000,'UNPAID',?,?),(2,1,1,1,'GST','S-NEW','2026-07-01',2500,0,2500,1000,1500,0,2500,'UNPAID',?,?)",
    "INSERT INTO sale_lines(id,sale_id,item_id,quantity_milliunits,sale_rate_ten_thousandths,gst_basis_points,subtotal_paise,gst_amount_paise,line_total_paise,fifo_cost_paise,gross_profit_paise) VALUES(1,1,1,1000,20000,0,2000,0,2000,1000,1000),(2,2,1,1000,25000,0,2500,0,2500,1000,1500)",
    "INSERT INTO inter_company_transfers(id,from_company_id,from_stock_book_id,to_company_id,to_stock_book_id,reference_number,transfer_date,total_fifo_value_paise,created_at,updated_at) VALUES(1,1,1,2,2,'TRF-1','2026-07-05',5000,?,?)",
    "INSERT INTO inter_company_ledger_entries(id,stock_owner_company_id,stock_user_company_id,transfer_id,item_id,quantity_milliunits,amount_owed_paise,settled_amount_paise,balance_amount_paise,status,created_at,updated_at) VALUES(1,1,2,1,1,1000,5000,0,5000,'PENDING',?,?)",
  ];
  for(const sql of statements){const count=(sql.match(/\?/g)??[]).length;await db.prepare(sql).bind(...Array(count).fill(t)).run();}
  return db;
}

describe("read/report parity polish",()=>{
  it("nets grouped outstanding against advances and keeps detail arithmetic reconcilable",async()=>{const db=await database();const result=await new ReportRepository(db,{activeCompanyId:1}).named("customer-outstanding",{query:"INV",status:"PARTIAL"});expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject({document_count:2,total_amount_paise:15000,document_paid_amount_paise:2000,advance_amount_paise:3500,advance_offset_paise:3500,open_advance_paise:0,paid_amount_paise:5500,balance_amount_paise:9500,status:"PARTIAL"});const supplier=await new ReportRepository(db,{activeCompanyId:1}).named("supplier-outstanding");expect(supplier.rows[0]).toMatchObject({advance_amount_paise:1000,paid_amount_paise:2000,balance_amount_paise:7000});});
  it("shows opening advances and scopes inter-company rows from either side",async()=>{const db=await database();const openings=await new ReportRepository(db,{activeCompanyId:1}).named("opening-summary");expect(openings.rows.map(row=>row.kind)).toEqual(expect.arrayContaining(["OPENING_ADVANCE_RECEIVED","OPENING_ADVANCE_PAID"]));const incoming=await new ReportRepository(db,{activeCompanyId:2}).named("inter-company");expect(incoming.rows).toHaveLength(1);expect(incoming.rows[0]).toMatchObject({owner_company:"FML",user_company:"AI"});});
  it("compares only the latest two prices per item and actual party",async()=>{const db=await database();const purchases=await new ReportRepository(db,{activeCompanyId:1}).named("purchase-price-fluctuation");expect(purchases.rows).toHaveLength(1);expect(purchases.rows[0]).toMatchObject({supplier:"Supplier One",previous_rate_ten_thousandths:10000,latest_rate_ten_thousandths:12000,change_ten_thousandths:2000,change_basis_points:2000});const sales=await new ReportRepository(db,{activeCompanyId:1}).named("sale-price-fluctuation");expect(sales.rows).toHaveLength(1);expect(sales.rows[0]).toMatchObject({customer:"Buyer One",previous_rate_ten_thousandths:20000,latest_rate_ten_thousandths:25000});});
});

describe("legal sale invoice",()=>{
  it("carries seller/buyer GST, tax split, words and configured bank details into view and PDF rows",()=>{const invoice=saleInvoiceModel({invoice_number:"INV-7",invoice_date:"2026-07-15",due_date:"2026-08-14",sale_type:"GST",subtotal_paise:10000,gst_total_paise:1800,grand_total_paise:11800},{code:"FML",name:"Firsttech",gst_number:"27CUSTOMGST"},{name:"Buyer",gst_number:"27BUYERGST",address:"Line one\nLine two",city:"Mumbai",state:"Maharashtra"},[{code:"ITM",name:"Tool",unit:"pcs",hsn:"8205",quantity_milliunits:1000,sale_rate_ten_thousandths:1000000,gst_basis_points:1800,subtotal_paise:10000,gst_amount_paise:1800,line_total_paise:11800}]);expect(invoice).toMatchObject({cgstTotal:900,sgstTotal:900,amountWords:"INR One Hundred Eighteen Only"});const html=saleInvoiceHtml(invoice);expect(html).toContain("27CUSTOMGST");expect(html).toContain("27BUYERGST");expect(html).toContain("Kotak Mahindra Bank");expect(html).toContain("CGST rate");expect(saleInvoicePdfRows(invoice).some(row=>row.Value==="7647407025")).toBe(true);expect(amountInWords(12_345_667)).toBe("INR One Lakh Twenty Three Thousand Four Hundred Fifty Six and Sixty Seven Paise Only");});
});
