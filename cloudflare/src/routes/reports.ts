import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { can } from "../security/permissions";
import { REPORT_NAMES, REPORTS, ReportRepository, printableRows, toCsv, toPdf, toXlsx, type ReportFilters } from "../reports";
import { escapeHtml, layout, table } from "../views/html";

const reports = new Hono<{ Bindings: Env; Variables: AppVariables }>();
type Row = Record<string, unknown>;

function filters(c: any): ReportFilters {
  const number = (name:string) => { const raw=c.req.query(name); if (!raw) return undefined; const value=Number(raw); return Number.isSafeInteger(value) ? value : Number.NaN; };
  return clean({ from:c.req.query("date_from") ?? c.req.query("from"), to:c.req.query("date_to") ?? c.req.query("to"), companyId:number("company_id"), itemId:number("item_id"), stockBookId:number("stock_book_id"), customerId:number("customer_id"), supplierId:number("supplier_id"), cursorDate:c.req.query("cursor_date"), cursorId:number("cursor_id"), cursorKey:c.req.query("cursor_key"), limit:number("limit"), month:c.req.query("month"), query:c.req.query("q"), status:c.req.query("status") } as ReportFilters);
}
function clean(input:ReportFilters):ReportFilters { return Object.fromEntries(Object.entries(input).filter(([,v])=>v!==undefined)) as ReportFilters; }
function filename(name:string):string { return name.replace(/[^a-z0-9-]/gi,"-"); }
function exportQuery(query:URLSearchParams,format:string):string { const copy=new URLSearchParams(query.toString());copy.delete("cursor_date");copy.delete("cursor_id");copy.delete("cursor_key");copy.set("format",format);return copy.toString(); }
async function render(c:any,name:string, extra:ReportFilters={}) {
  const user=c.get("user")!; if (!can(user,"reports","view")) return c.text("Forbidden",403);
  const definition=REPORTS[name]; if (!definition) return c.notFound();
  let result; try { result=await new ReportRepository(c.env.DB,{activeCompanyId:user.activeCompanyId}).named(name,clean({...filters(c),...extra})); } catch(error) { return c.text(error instanceof Error ? error.message : "Invalid filters",400); }
  const outputRows=result.rows.map(({id: _internalId,...row}:Row)=>row);
  const format=c.req.query("format");
  if (format) {
    if (!can(user,"reports","export")) return c.text("Forbidden",403);
    if (format==="csv") return new Response(toCsv(outputRows),{headers:{"content-type":"text/csv; charset=utf-8","content-disposition":`attachment; filename="${filename(name)}.csv"`}});
    if (format==="xlsx") return new Response(toXlsx(outputRows,definition.title),{headers:{"content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","content-disposition":`attachment; filename="${filename(name)}.xlsx"`}});
    if (format==="pdf") return new Response(toPdf(definition.title,outputRows),{headers:{"content-type":"application/pdf","content-disposition":`attachment; filename="${filename(name)}.pdf"`}});
    if (format!=="print") return c.text("Unsupported format",400);
  }
  const printable=printableRows(outputRows);
  const query=new URL(c.req.url).searchParams;
  if(result.nextCursor?.date)query.set("cursor_date",result.nextCursor.date);else query.delete("cursor_date");
  if(result.nextCursor?.id)query.set("cursor_id",String(result.nextCursor.id));else query.delete("cursor_id");
  if(result.nextCursor?.key)query.set("cursor_key",result.nextCursor.key);else query.delete("cursor_key");
  const more=result.hasMore && result.nextCursor ? `<p><a href="?${escapeHtml(query.toString())}">Next page</a></p>`:"";
  const exports=can(user,"reports","export")?`<nav class="inline-actions"><a href="?${escapeHtml(exportQuery(query,"csv"))}">CSV</a><a href="?${escapeHtml(exportQuery(query,"xlsx"))}">XLSX</a><a href="?${escapeHtml(exportQuery(query,"pdf"))}">PDF</a></nav>`:"";
  return c.html(layout(definition.title,exports+table(printable.headers.map(escapeHtml),printable.rows.map(row=>row.map(escapeHtml)))+more,user));
}

reports.get("/",(c)=>{ const user=c.get("user")!; if(!can(user,"reports","view")) return c.text("Forbidden",403); return c.html(layout("Reports",`<ul>${REPORT_NAMES.map(name=>`<li><a href="/reports/${name}">${escapeHtml(REPORTS[name]!.title)}</a></li>`).join("")}</ul>`,user)); });
reports.get("/item-ledger",(c)=>render(c,"item-ledger"));
reports.get("/customer-ledger",(c)=>render(c,"customer-ledger"));
reports.get("/customer-ledger/detail",(c)=>{ const month=c.req.query("month"); if(!/^\d{4}-\d{2}$/.test(month??"")) return c.text("Valid month is required",400); const end=new Date(`${month}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth()+1); end.setUTCDate(0); return render(c,"customer-ledger",{from:`${month}-01`,to:end.toISOString().slice(0,10)}); });
reports.get("/:name",(c)=>render(c,c.req.param("name")));

export default reports;
