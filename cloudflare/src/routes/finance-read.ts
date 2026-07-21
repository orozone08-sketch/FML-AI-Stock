import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { can } from "../security/permissions";
import { ReportRepository, toCsv, type ReportFilters } from "../reports";
import { escapeHtml, layout, money, table } from "../views/html";

const financeRead=new Hono<{Bindings:Env;Variables:AppVariables}>();
type Row=Record<string,unknown>;
function repository(c:any){return new ReportRepository(c.env.DB,{activeCompanyId:c.get("user")!.activeCompanyId});}
function filters(c:any):ReportFilters{const company=c.req.query("company_id"),status=c.req.query("status"),query=c.req.query("q");return{...(company?{companyId:Number(company)}:{}),...(status?{status}:{}),...(query?{query}:{})} as ReportFilters;}
async function completeOutstanding(c:any,name:"customer-outstanding"|"supplier-outstanding",input:ReportFilters){
  const rows:Row[]=[];let cursor:ReportFilters={...input,limit:500};
  for(;;){const page=await repository(c).named(name,cursor);rows.push(...page.rows);if(!page.hasMore||!page.nextCursor)break;cursor={...input,limit:500,...(page.nextCursor.date?{cursorDate:page.nextCursor.date}:{}),...(page.nextCursor.id?{cursorId:page.nextCursor.id}:{}),...(page.nextCursor.key?{cursorKey:page.nextCursor.key}:{})};}
  return {rows,hasMore:false,nextCursor:null};
}

async function listing(c:any){
  const user=c.get("user")!;if(!can(user,"outstanding","view"))return c.text("Forbidden",403);
  const input=filters(c);let customers,suppliers;
  const empty={rows:[],hasMore:false,nextCursor:null};
  try{[customers,suppliers]=input.status==="ADVANCE"||input.status==="PAID"?[empty,empty]:await Promise.all([completeOutstanding(c,"customer-outstanding",input),completeOutstanding(c,"supplier-outstanding",input)]);}catch(error){return c.text(error instanceof Error?error.message:"Invalid filters",400);}
  const companyId=user.activeCompanyId??input.companyId;
  const advanceWhere=["p.unallocated_amount_paise>0"],advanceValues:unknown[]=[];
  if(companyId){advanceWhere.push("p.company_id=?");advanceValues.push(companyId);}
  if(input.query){const like=`%${input.query.toLowerCase()}%`;advanceWhere.push("(LOWER(COALESCE(p.reference_number,'')) LIKE ? OR LOWER(p.payment_type) LIKE ? OR LOWER(p.mode) LIKE ? OR LOWER(COALESCE(cu.name,s.name,'')) LIKE ?)");advanceValues.push(like,like,like,like);}
  const advances=input.status&&input.status!=="ADVANCE"?[]:((await c.env.DB.prepare(`SELECT p.id,p.payment_date date,c.code company,p.party_type,COALESCE(cu.name,s.name) party,p.payment_type,p.mode,p.reference_number,p.total_amount_paise,p.allocated_amount_paise,p.unallocated_amount_paise FROM payments p JOIN companies c ON c.id=p.company_id LEFT JOIN customers cu ON cu.id=p.customer_id LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE ${advanceWhere.join(" AND ")} ORDER BY p.payment_date DESC,p.id DESC`).bind(...advanceValues).all()).results??[]) as Row[];
  const rows=[...customers.rows.map(r=>({...r,party_type:"CUSTOMER"})),...suppliers.rows.map(r=>({...r,party_type:"SUPPLIER"}))];
  if(c.req.query("format")){if(!can(user,"outstanding","export"))return c.text("Forbidden",403);return new Response(toCsv([...rows,...advances.map(row=>({...row,record_type:"UNALLOCATED_ADVANCE"}))]),{headers:{"content-type":"text/csv; charset=utf-8","content-disposition":"attachment; filename=outstanding.csv"}});}
  const customerRows=customers.rows.map((r:any)=>[escapeHtml(r.company),`<a class="table-action" href="/finance/outstanding/customer/${r.company_id}/${r.customer_id}">${escapeHtml(r.customer)}</a>`,escapeHtml(r.documents),escapeHtml(r.date),escapeHtml(r.earliest_due),`₹${money(r.total_amount_paise)}`,`₹${money(r.document_paid_amount_paise)}`,`₹${money(Number(r.advance_offset_paise??0)+Number(r.open_advance_paise??0))}`,`₹${money(r.balance_amount_paise)}`,escapeHtml(r.status),`<a class="table-action" href="/finance/outstanding/customer/${r.company_id}/${r.customer_id}">Details</a>`]);
  const supplierRows=suppliers.rows.map((r:any)=>[escapeHtml(r.company),`<a class="table-action" href="/finance/outstanding/supplier/${r.company_id}/${r.supplier_id}">${escapeHtml(r.supplier)}</a>`,escapeHtml(r.documents),escapeHtml(r.date),escapeHtml(r.earliest_due),`₹${money(r.total_amount_paise)}`,`₹${money(r.document_paid_amount_paise)}`,`₹${money(Number(r.advance_offset_paise??0)+Number(r.open_advance_paise??0))}`,`₹${money(r.balance_amount_paise)}`,escapeHtml(r.status),`<a class="table-action" href="/finance/outstanding/supplier/${r.company_id}/${r.supplier_id}">Details</a>`]);
  const advanceRows=advances.map((r:any)=>[escapeHtml(r.date),escapeHtml(r.company),escapeHtml(r.payment_type),escapeHtml(r.party),`₹${money(r.total_amount_paise)}`,`₹${money(r.allocated_amount_paise)}`,`₹${money(r.unallocated_amount_paise)}`]);
  const receivable=customers.rows.reduce((sum,row:any)=>sum+Number(row.balance_amount_paise??0),0),payable=suppliers.rows.reduce((sum,row:any)=>sum+Number(row.balance_amount_paise??0),0),advance=advances.reduce((sum,row:any)=>sum+Number(row.unallocated_amount_paise??0),0);
  const controls=`<section class="panel"><form method="get" class="toolbar" data-live-search-form><input name="q" value="${escapeHtml(input.query)}" placeholder="Search" autocomplete="off" data-live-search data-live-target="#outstanding_tables"><select name="status"><option value="">All statuses</option>${["UNPAID","PARTIAL","PAID","ADVANCE"].map(value=>`<option value="${value}" ${input.status===value?"selected":""}>${value}</option>`).join("")}</select><button class="secondary-button" type="submit" data-live-find>Find</button></form></section>`;
  const summary=`<section class="metric-grid outstanding-summary" data-outstanding-summary data-live-summary-target="#outstanding_tables"><article class="metric-card" data-summary-table="receivables" data-summary-column="8"><span>Customer Balance</span><strong>₹${money(receivable)}</strong><small>${customers.rows.length} customer${customers.rows.length===1?"":"s"}</small></article><article class="metric-card amber" data-summary-table="payables" data-summary-column="8"><span>Supplier Balance</span><strong>₹${money(payable)}</strong><small>${suppliers.rows.length} supplier${suppliers.rows.length===1?"":"s"}</small></article><article class="metric-card" data-summary-table="advances" data-summary-column="6"><span>Open Advances</span><strong>₹${money(advance)}</strong><small>${advances.length} advance${advances.length===1?"":"s"}</small></article></section>`;
  const panel=(title:string,href:string,headers:string[],rows:unknown[][],emptyText:string,id:string)=>`<section class="panel"><div class="panel-title"><h2>${title}</h2><a href="${href}">Export report</a></div><div class="table-wrap"><table data-summary-name="${id}"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.length?rows.map(row=>`<tr>${row.map(cell=>`<td>${cell}</td>`).join("")}</tr>`).join(""):`<tr><td colspan="${headers.length}" class="empty">${emptyText}</td></tr>`}</tbody></table></div></section>`;
  const content=`${controls}<div id="outstanding_tables">${summary}${panel("Customer Outstanding","/reports/customer-outstanding",["Company","Customer","Documents","First date","Next due","Debit bills","Credit received","Advance credit","Closing balance","Status","Actions"],customerRows,"No receivables.","receivables")}${panel("Supplier Outstanding","/reports/supplier-outstanding",["Company","Supplier","Documents","First date","Next due","Debit bills","Credit paid","Advance","Closing balance","Status","Actions"],supplierRows,"No payables.","payables")}${panel("Advances","/reports/advances",["Date","Company","Type","Party","Original","Allocated","Unallocated"],advanceRows,"No advances.","advances")}</div>`;
  return c.html(layout("Outstanding",content,user,{subtitle:"Customer receivables, supplier payables, and unallocated advances."}));
}

async function detail(c:any,kind:"customer"|"supplier"){
  const user=c.get("user")!;if(!can(user,"outstanding","view"))return c.text("Forbidden",403);
  const companyId=Number(c.req.param("companyId")),partyId=Number(c.req.param(kind==="customer"?"customerId":"supplierId"));
  if(!Number.isSafeInteger(companyId)||companyId<=0||!Number.isSafeInteger(partyId)||partyId<=0)return c.notFound();
  if(user.activeCompanyId&&companyId!==user.activeCompanyId)return c.text("Forbidden",403);
  const partyTable=kind==="customer"?"customers":"suppliers",documentTable=kind==="customer"?"receivables":"payables",partyColumn=kind==="customer"?"customer_id":"supplier_id";
  const [identity,documents,advances]=await c.env.DB.batch([
    c.env.DB.prepare(`SELECT p.id,p.code,p.name,c.code company,c.name company_name FROM ${partyTable} p CROSS JOIN companies c WHERE p.id=? AND c.id=?`).bind(partyId,companyId),
    c.env.DB.prepare(`SELECT id,document_number,document_date,due_date,transaction_type,source_type,total_amount_paise,paid_amount_paise,balance_amount_paise,payment_status,remarks FROM ${documentTable} WHERE company_id=? AND ${partyColumn}=? AND balance_amount_paise>0 ORDER BY document_date,document_number,id`).bind(companyId,partyId),
    c.env.DB.prepare(`SELECT id,payment_date,payment_type,mode,reference_number,total_amount_paise,allocated_amount_paise,unallocated_amount_paise,remarks FROM payments WHERE company_id=? AND ${partyColumn}=? AND unallocated_amount_paise>0 ORDER BY payment_date,id`).bind(companyId,partyId),
  ]);
  const party=identity?.results?.[0] as Row|undefined;if(!party)return c.notFound();
  const docs=(documents?.results??[]) as Row[],advanceRows=(advances?.results??[]) as Row[];
  const total=docs.reduce((sum,row)=>sum+Number(row.total_amount_paise??0),0),documentPaid=docs.reduce((sum,row)=>sum+Number(row.paid_amount_paise??0),0),documentBalance=docs.reduce((sum,row)=>sum+Number(row.balance_amount_paise??0),0),advance=advanceRows.reduce((sum,row)=>sum+Number(row.unallocated_amount_paise??0),0),offset=Math.min(documentBalance,advance),closing=Math.max(documentBalance-advance,0);
  const summary=`<section class="metric-grid"><article class="metric-card"><span>Bill total</span><strong>₹${money(total)}</strong></article><article class="metric-card"><span>Document paid</span><strong>₹${money(documentPaid)}</strong></article><article class="metric-card"><span>Advance offset</span><strong>₹${money(offset)}</strong><small>₹${money(Math.max(advance-offset,0))} remains open</small></article><article class="metric-card danger"><span>Closing outstanding</span><strong>₹${money(closing)}</strong></article></section>`;
  const docRows=docs.map(row=>[escapeHtml(row.document_number),escapeHtml(row.document_date),escapeHtml(row.due_date),escapeHtml(row.transaction_type??row.source_type),money(row.total_amount_paise),money(row.paid_amount_paise),money(row.balance_amount_paise),escapeHtml(row.payment_status),escapeHtml(row.remarks)]);
  const paymentRows=advanceRows.map(row=>[escapeHtml(row.payment_date),escapeHtml(row.payment_type),escapeHtml(row.mode),escapeHtml(row.reference_number),money(row.total_amount_paise),money(row.allocated_amount_paise),money(row.unallocated_amount_paise)]);
  return c.html(layout(`${kind==="customer"?"Customer":"Supplier"} Outstanding`, `<section class="hero-panel"><div><h2>${escapeHtml(party.name)}</h2><p>${escapeHtml(party.code)} · ${escapeHtml(party.company)} ${escapeHtml(party.company_name)}</p></div></section>${summary}<section class="panel"><div class="panel-title"><h2>Open Documents</h2></div>${table(["Document","Date","Due","Type","Total","Document paid","Document balance","Status","Remarks"],docRows)}</section><section class="panel"><div class="panel-title"><h2>Unallocated Advances</h2></div>${table(["Date","Type","Mode","Reference","Original","Allocated","Unallocated"],paymentRows)}</section>`,user,{subtitle:"Document balances, allocations, and open advances."}));
}

financeRead.get("/outstanding",listing);
financeRead.get("/outstanding/customer/:companyId/:customerId",(c)=>detail(c,"customer"));
financeRead.get("/outstanding/supplier/:companyId/:supplierId",(c)=>detail(c,"supplier"));

export default financeRead;
