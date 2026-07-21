import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { can } from "../security/permissions";
import { REPORT_NAMES, REPORTS, ReportRepository, printableRows, toCsv, toPdf, toXlsx, type ReportFilters } from "../reports";
import { escapeHtml, layout } from "../views/html";

const reports = new Hono<{ Bindings: Env; Variables: AppVariables }>();
type Row = Record<string, unknown>;

function filters(c: any): ReportFilters {
  const number = (name:string) => { const raw=c.req.query(name); if (!raw) return undefined; const value=Number(raw); return Number.isSafeInteger(value) ? value : Number.NaN; };
  return clean({ from:c.req.query("date_from") ?? c.req.query("from"), to:c.req.query("date_to") ?? c.req.query("to"), companyId:number("company_id"), itemId:number("item_id"), stockBookId:number("stock_book_id"), customerId:number("customer_id"), supplierId:number("supplier_id"), cursorDate:c.req.query("cursor_date"), cursorId:number("cursor_id"), cursorKey:c.req.query("cursor_key"), limit:number("limit"), month:c.req.query("month"), query:c.req.query("q"), status:c.req.query("status") } as ReportFilters);
}
function clean(input:ReportFilters):ReportFilters { return Object.fromEntries(Object.entries(input).filter(([,v])=>v!==undefined)) as ReportFilters; }
function filename(name:string):string { return name.replace(/[^a-z0-9-]/gi,"-"); }
function exportQuery(query:URLSearchParams,format:string):string { const copy=new URLSearchParams(query.toString());copy.delete("cursor_date");copy.delete("cursor_id");copy.delete("cursor_key");copy.set("format",format);return copy.toString(); }
function reportPath(name:string):string { return name === "item-ledger" || name === "customer-ledger" ? `/reports/${name}` : `/reports/${name}`; }
export function reportToolbar(c:any,name:string,query:URLSearchParams,allowExport:boolean,choices:{companies?:Row[];items?:Row[];books?:Row[];customers?:Row[];activeCompanyId?:number|null}={}):string {
  const field=(key:string,label:string,type="text")=>`<input type="${type}" name="${key}" value="${escapeHtml(c.req.query(key)??"")}" placeholder="${label}" aria-label="${label}"${key==="q"?' autocomplete="off" data-live-search data-live-target="#report_table"':""}>`;
  const exports=allowExport?`<span class="spacer"></span><a class="secondary-button" href="?${escapeHtml(exportQuery(query,"csv"))}">CSV</a><a class="secondary-button" href="?${escapeHtml(exportQuery(query,"xlsx"))}">XLSX</a><a class="secondary-button" href="?${escapeHtml(exportQuery(query,"pdf"))}">PDF</a><a class="secondary-button" href="?${escapeHtml(exportQuery(query,"print"))}" target="_blank" rel="noopener">Print</a>`:"";
  const option=(row:Row,selected:unknown)=>`<option value="${escapeHtml(row.id)}" ${Number(row.id)===Number(selected)?"selected":""}>${escapeHtml(row.code)} - ${escapeHtml(row.name)}</option>`;
  const companySelect=choices.companies?`<select name="company_id" ${choices.activeCompanyId?"disabled":""}>${choices.activeCompanyId?"":'<option value="">All companies</option>'}${choices.companies.map(row=>option(row,c.req.query("company_id")??choices.activeCompanyId)).join("")}</select>${choices.activeCompanyId?`<input type="hidden" name="company_id" value="${choices.activeCompanyId}">`:""}`:"";
  const item=choices.items?.find(row=>Number(row.id)===Number(c.req.query("item_id")));
  const itemPicker=choices.items?`<div class="item-combobox" data-option-picker data-picker-label="item" data-picker-prefix="report_item"><input name="item_search" type="text" value="${item?escapeHtml(`${item.code} - ${item.name}`):""}" placeholder="Type item code or name" autocomplete="off" required data-option-search><input name="item_id" type="hidden" value="${escapeHtml(c.req.query("item_id")??"")}" data-option-value><button type="button" class="item-combobox-button" data-option-open aria-label="Show item list"></button><datalist data-option-list>${choices.items.map(row=>`<option value="${escapeHtml(`${row.code} - ${row.name}`)}" data-option-id="${escapeHtml(row.id)}"></option>`).join("")}</datalist></div>`:"";
  const identifiers=name==="item-ledger"?`${itemPicker}${companySelect}<select name="stock_book_id"><option value="">All stock books</option>${(choices.books??[]).map(row=>option(row,c.req.query("stock_book_id"))).join("")}</select>`:name==="customer-ledger"?`${companySelect}<select name="customer_id"><option value="">All customers</option>${(choices.customers??[]).map(row=>option(row,c.req.query("customer_id"))).join("")}</select>${field("month","Month","month")}`:"";
  return `<form class="toolbar" method="get" data-live-search-form><a class="secondary-button" href="/reports/">All reports</a>${identifiers}${field("date_from","From date","date")}${field("date_to","To date","date")}${field("q","Search report")}<button class="secondary-button" type="submit" data-live-find>Find</button>${exports}</form>`;
}
function rowActions(name:string,row:Row):string {
  const id=Number(row.id); if(!Number.isSafeInteger(id)||id<=0)return "";
  if(name==="sales")return `<a class="table-action" href="/transactions/sale/${id}/view" target="_blank" rel="noopener">View</a><a class="table-action" href="/transactions/sale/${id}/export/pdf">PDF</a>`;
  if(name==="purchases")return `<a class="table-action" href="/transactions/purchase/${id}/print" target="_blank" rel="noopener">Print</a><a class="table-action" href="/transactions/purchase/${id}/export/pdf">PDF</a>`;
  return "";
}
export function reportTable(name:string,headers:string[],rows:string[][],sourceRows:Row[]):string {
  const actions=sourceRows.map(row=>rowActions(name,row)),hasActions=actions.some(Boolean),width=headers.length+(hasActions?1:0);
  return `<div class="table-wrap tall"><table id="report_table" data-selectable-rows data-row-select-key="report-${escapeHtml(name)}"><thead><tr>${headers.map(header=>`<th>${escapeHtml(header)}</th>`).join("")}${hasActions?"<th>Actions</th>":""}</tr></thead><tbody>${rows.length?rows.map((row,index)=>`<tr data-row-key="${escapeHtml(name)}-${index+1}">${row.map(cell=>`<td>${escapeHtml(cell)}</td>`).join("")}${hasActions?`<td class="actions">${actions[index]??""}</td>`:""}</tr>`).join(""):`<tr><td colspan="${width}" class="empty">No rows for this report.</td></tr>`}<tr class="empty live-empty" data-live-empty hidden><td colspan="${width}">No matching rows.</td></tr></tbody></table></div>`;
}
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
  const more=result.hasMore && result.nextCursor ? `<div class="form-actions"><a class="secondary-button" href="?${escapeHtml(query.toString())}">Next page</a></div>`:"";
  let choices:{companies?:Row[];items?:Row[];books?:Row[];customers?:Row[];activeCompanyId?:number|null}={};
  if(name==="item-ledger"||name==="customer-ledger"){
    const scoped=user.activeCompanyId?" WHERE id=?":"",bind=user.activeCompanyId?[user.activeCompanyId]:[];
    const statements=[c.env.DB.prepare(`SELECT id,code,name FROM companies${scoped} ORDER BY code`).bind(...bind)];
    if(name==="item-ledger")statements.push(c.env.DB.prepare("SELECT id,code,name FROM items WHERE active=1 ORDER BY code LIMIT 500"),c.env.DB.prepare(`SELECT id,code,name FROM stock_books${user.activeCompanyId?" WHERE company_id=?":""} AND active=1`.replace("stock_books AND","stock_books WHERE")).bind(...bind));
    else statements.push(c.env.DB.prepare("SELECT id,code,name FROM customers WHERE active=1 ORDER BY code LIMIT 500"));
    const optionResults=await c.env.DB.batch(statements);
    choices={companies:(optionResults[0]?.results??[]) as Row[],activeCompanyId:user.activeCompanyId};
    if(name==="item-ledger"){choices.items=(optionResults[1]?.results??[]) as Row[];choices.books=(optionResults[2]?.results??[]) as Row[];}else choices.customers=(optionResults[1]?.results??[]) as Row[];
  }
  const body=`<section class="panel">${reportToolbar(c,name,query,can(user,"reports","export"),choices)}${reportTable(name,printable.headers,printable.rows,result.rows as Row[])}${more}</section>`;
  return c.html(layout(definition.title,body,user,{subtitle:"Use exports for print-friendly PDF, spreadsheet, or CSV output.",scripts:format==="print"?"<span hidden data-auto-print></span>":""}));
}

reports.get("/",(c)=>{ const user=c.get("user")!; if(!can(user,"reports","view")) return c.text("Forbidden",403); return c.html(layout("Reports",`<section class="report-grid">${REPORT_NAMES.map(name=>`<a class="report-card" href="${reportPath(name)}"><strong>${escapeHtml(REPORTS[name]!.title)}</strong><span>Open report</span></a>`).join("")}</section>`,user,{subtitle:"Stock, FIFO, sales, payments, alerts, inter-company, and audit reports."})); });
reports.get("/item-ledger",(c)=>render(c,"item-ledger"));
reports.get("/customer-ledger",(c)=>render(c,"customer-ledger"));
reports.get("/customer-ledger/detail",(c)=>{ const month=c.req.query("month"); if(!/^\d{4}-\d{2}$/.test(month??"")) return c.text("Valid month is required",400); const end=new Date(`${month}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth()+1); end.setUTCDate(0); return render(c,"customer-ledger",{from:`${month}-01`,to:end.toISOString().slice(0,10)}); });
reports.get("/:name",(c)=>render(c,c.req.param("name")));

export default reports;
