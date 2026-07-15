import { describe, expect, it } from "vitest";
import { REPORT_NAMES, REPORTS, ReportRepository, formatScaled, normalizeFilters, printableRows, toCsv, toPdf, toXlsx } from "../../src/reports";

function fakeDb(rows: Record<string, unknown>[] = []) {
  const calls: Array<{ sql:string; values:unknown[] }> = [];
  const db = {
    prepare(sql:string) {
      const call = { sql, values: [] as unknown[] }; calls.push(call);
      return { bind(...values:unknown[]) { call.values=values; return this; }, async all() { return { results:rows, success:true, meta:{} }; } };
    },
  };
  return { db: db as unknown as D1Database, calls };
}

describe("report catalog", () => {
  it("covers all 23 legacy report names without SELECT star", () => {
    expect(REPORT_NAMES).toHaveLength(23);
    expect(REPORT_NAMES).toEqual(expect.arrayContaining(["item-ledger","customer-ledger","audit","gross-profit","opening-summary"]));
    for (const report of Object.values(REPORTS)) {
      expect(report.sql.toUpperCase()).not.toMatch(/SELECT\s+(?:\w+\.)?\*/);
      expect(report.sql).toMatch(/^SELECT /);
    }
  });
});

describe("bounded report filters", () => {
  it("forces the active company and clamps page size", () => {
    expect(normalizeFilters({ limit: 999 }, { activeCompanyId: 7 })).toMatchObject({ companyId: 7, limit: 200 });
    expect(() => normalizeFilters({ companyId: 8 }, { activeCompanyId: 7 })).toThrow(/outside/);
  });

  it("rejects malformed and excessive date ranges and partial cursors", () => {
    expect(() => normalizeFilters({ from:"2026-02-30" }, { activeCompanyId:null })).toThrow(/Invalid/);
    expect(() => normalizeFilters({ from:"2024-01-01",to:"2026-01-01" }, { activeCompanyId:null })).toThrow(/exceeds/);
    expect(() => normalizeFilters({ cursorDate:"2026-01-01" }, { activeCompanyId:null })).toThrow(/requires/);
    expect(() => normalizeFilters({ cursorKey:"bad" }, { activeCompanyId:null })).toThrow(/cursorKey/);
  });
});

describe("scaled integer exports", () => {
  it("formats scaled values without floating-point arithmetic", () => {
    expect(formatScaled("grand_total_paise", 123456)).toBe("1234.56");
    expect(formatScaled("quantity_milliunits", 12050)).toBe("12.05");
    expect(formatScaled("rate_ten_thousandths", 12345)).toBe("1.2345");
    expect(formatScaled("gst_basis_points", 1800)).toBe("18");
  });

  it("produces Excel-friendly escaped CSV and printable cells", () => {
    const source = [{ party:'Acme, "West"', balance_amount_paise:12345, quantity_milliunits:2500 }];
    const csv = toCsv(source);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"Acme, ""West"""');
    expect(csv).toContain("123.45");
    expect(printableRows(source).rows[0]).toEqual(['Acme, "West"',"123.45","2.5"]);
  });

  it("produces genuine XLSX and PDF binary formats", () => {
    const rows=[{party:"Acme",balance_amount_paise:12345}];
    const xlsx=toXlsx(rows,"Outstanding");
    expect(Array.from(xlsx.slice(0,4))).toEqual([0x50,0x4b,0x03,0x04]);
    expect(new TextDecoder().decode(xlsx)).toContain("xl/worksheets/sheet1.xml");
    const pdf=toPdf("Outstanding",rows);
    expect(new TextDecoder().decode(pdf.slice(0,8))).toBe("%PDF-1.4");
    expect(new TextDecoder().decode(pdf.slice(-20))).toContain("%%EOF");
  });
});

describe("D1 report repository", () => {
  it("binds company/date/keyset filters and fetches one look-ahead row", async () => {
    const { db, calls } = fakeDb([{ date:"2026-06-01", id:9 },{ date:"2026-05-31", id:8 }]);
    const result = await new ReportRepository(db,{ activeCompanyId:4 }).named("sales",{ from:"2026-01-01",to:"2026-06-30",cursorDate:"2026-06-02",cursorId:10,limit:1 });
    expect(result).toMatchObject({ hasMore:true, rows:[{ id:9 }], nextCursor:{ date:"2026-06-01",id:9 } });
    expect(calls[0]?.sql).toContain("s.company_id=?");
    expect(calls[0]?.sql).toContain("ORDER BY s.invoice_date DESC, s.id DESC LIMIT ?");
    expect(calls[0]?.sql.toUpperCase()).not.toContain("SELECT *");
    expect(calls[0]?.values).toEqual([4,"2026-01-01","2026-06-30","2026-06-02","2026-06-02",10,2]);
  });

  it("applies customer and supplier filters instead of silently ignoring them",async()=>{
    const customer=fakeDb([]);await new ReportRepository(customer.db,{activeCompanyId:4}).named("customer-ledger",{customerId:7});
    expect(customer.calls[0]?.sql).toContain("x.customer_id=?");expect(customer.calls[0]?.values).toEqual([4,7,51]);
    const supplier=fakeDb([]);await new ReportRepository(supplier.db,{activeCompanyId:4}).named("purchases",{supplierId:9});
    expect(supplier.calls[0]?.sql).toContain("p.supplier_id=?");expect(supplier.calls[0]?.values).toEqual([4,9,51]);
  });

  it("paginates dateless composite inventory rows with an opaque stable cursor",async()=>{
    const key="0000000001:0000000002:0000000003";
    const capture=fakeDb([{id:3,cursor_key:key},{id:2,cursor_key:"0000000001:0000000002:0000000002"}]);
    const result=await new ReportRepository(capture.db,{activeCompanyId:1}).named("current-stock",{limit:1});
    expect(result).toMatchObject({hasMore:true,nextCursor:{key},rows:[{id:3}]});
    const next=fakeDb([]);await new ReportRepository(next.db,{activeCompanyId:1}).named("current-stock",{cursorKey:key});
    expect(next.calls[0]?.sql).toContain("printf('%010d:%010d:%010d',sb.company_id,sb.id,i.id)<?");
  });
});
