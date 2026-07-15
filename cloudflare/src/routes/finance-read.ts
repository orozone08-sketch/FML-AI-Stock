import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { can } from "../security/permissions";
import { ReportRepository, toCsv, type ReportFilters } from "../reports";
import { escapeHtml, layout, money, table } from "../views/html";

const financeRead=new Hono<{Bindings:Env;Variables:AppVariables}>();
type Row=Record<string,unknown>;
function repository(c:any){return new ReportRepository(c.env.DB,{activeCompanyId:c.get("user")!.activeCompanyId});}
function filters(c:any):ReportFilters{const company=c.req.query("company_id"),status=c.req.query("status"),query=c.req.query("q");return{...(company?{companyId:Number(company)}:{}),...(status?{status}:{}),...(query?{query}:{})} as ReportFilters;}

async function listing(c:any){
  const user=c.get("user")!;if(!can(user,"outstanding","view"))return c.text("Forbidden",403);
  const input=filters(c);let customers,suppliers;
  const empty={rows:[],hasMore:false,nextCursor:null};
  try{[customers,suppliers]=input.status==="ADVANCE"||input.status==="PAID"?[empty,empty]:await Promise.all([repository(c).named("customer-outstanding",input),repository(c).named("supplier-outstanding",input)]);}catch(error){return c.text(error instanceof Error?error.message:"Invalid filters",400);}
  const companyId=user.activeCompanyId??input.companyId;
  const advanceWhere=["p.unallocated_amount_paise>0"],advanceValues:unknown[]=[];
  if(companyId){advanceWhere.push("p.company_id=?");advanceValues.push(companyId);}
  if(input.query){const like=`%${input.query.toLowerCase()}%`;advanceWhere.push("(LOWER(COALESCE(p.reference_number,'')) LIKE ? OR LOWER(p.payment_type) LIKE ? OR LOWER(p.mode) LIKE ? OR LOWER(COALESCE(cu.name,s.name,'')) LIKE ?)");advanceValues.push(like,like,like,like);}
  const advances=input.status&&input.status!=="ADVANCE"?[]:((await c.env.DB.prepare(`SELECT p.id,p.payment_date date,c.code company,p.party_type,COALESCE(cu.name,s.name) party,p.payment_type,p.mode,p.reference_number,p.total_amount_paise,p.allocated_amount_paise,p.unallocated_amount_paise FROM payments p JOIN companies c ON c.id=p.company_id LEFT JOIN customers cu ON cu.id=p.customer_id LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE ${advanceWhere.join(" AND ")} ORDER BY p.payment_date DESC,p.id DESC LIMIT 201`).bind(...advanceValues).all()).results??[]) as Row[];
  const rows=[...customers.rows.map(r=>({...r,party_type:"CUSTOMER"})),...suppliers.rows.map(r=>({...r,party_type:"SUPPLIER"}))];
  if(c.req.query("format")){if(!can(user,"outstanding","export"))return c.text("Forbidden",403);return new Response(toCsv([...rows,...advances.map(row=>({...row,record_type:"UNALLOCATED_ADVANCE"}))]),{headers:{"content-type":"text/csv; charset=utf-8","content-disposition":"attachment; filename=outstanding.csv"}});}
  const customerRows=customers.rows.map((r:any)=>[escapeHtml(r.company),`<a href="/finance/outstanding/customer/${r.company_id}/${r.customer_id}">${escapeHtml(r.customer)}</a>`,escapeHtml(r.documents),money(r.total_amount_paise),money(r.document_paid_amount_paise),money(r.advance_amount_paise),money(r.balance_amount_paise),escapeHtml(r.status)]);
  const supplierRows=suppliers.rows.map((r:any)=>[escapeHtml(r.company),`<a href="/finance/outstanding/supplier/${r.company_id}/${r.supplier_id}">${escapeHtml(r.supplier)}</a>`,escapeHtml(r.documents),money(r.total_amount_paise),money(r.document_paid_amount_paise),money(r.advance_amount_paise),money(r.balance_amount_paise),escapeHtml(r.status)]);
  const advanceRows=advances.slice(0,200).map((r:any)=>[escapeHtml(r.date),escapeHtml(r.company),escapeHtml(r.party_type),escapeHtml(r.party),escapeHtml(r.reference_number),money(r.total_amount_paise),money(r.allocated_amount_paise),money(r.unallocated_amount_paise)]);
  const receivable=customers.rows.reduce((sum,row:any)=>sum+Number(row.balance_amount_paise??0),0),payable=suppliers.rows.reduce((sum,row:any)=>sum+Number(row.balance_amount_paise??0),0),advance=advances.reduce((sum,row:any)=>sum+Number(row.unallocated_amount_paise??0),0);
  const controls=`<form method="get" class="inline-filters"><input name="q" value="${escapeHtml(input.query)}" placeholder="Party, document or reference"><select name="status"><option value="">All statuses</option>${["UNPAID","PARTIAL","ADVANCE"].map(value=>`<option value="${value}" ${input.status===value?"selected":""}>${value}</option>`).join("")}</select><button>Filter</button></form>`;
  const summary=`<section class="metric-grid"><article class="metric-card danger"><span>Customer</span><strong>₹${money(receivable)}</strong><small>${customers.rows.length} parties after advances</small></article><article class="metric-card amber"><span>Supplier</span><strong>₹${money(payable)}</strong><small>${suppliers.rows.length} parties after advances</small></article><article class="metric-card"><span>Unallocated advances</span><strong>₹${money(advance)}</strong><small>${advances.length} payments</small></article></section>`;
  return c.html(layout("Outstanding",controls+summary+`<h2>Customer outstanding</h2>${table(["Company","Customer","Documents","Bills","Document paid","Advance credit","Closing","Status"],customerRows)}<h2>Supplier outstanding</h2>${table(["Company","Supplier","Documents","Bills","Document paid","Advance credit","Closing","Status"],supplierRows)}<h2>Open advances</h2>${table(["Date","Company","Type","Party","Reference","Original","Allocated","Unallocated"],advanceRows)}`,user));
}

async function detail(c:any,kind:"customer"|"supplier"){
  const user=c.get("user")!;if(!can(user,"outstanding","view"))return c.text("Forbidden",403);
  const companyId=Number(c.req.param("companyId")),partyId=Number(c.req.param(kind==="customer"?"customerId":"supplierId"));
  if(!Number.isSafeInteger(companyId)||companyId<=0||!Number.isSafeInteger(partyId)||partyId<=0)return c.notFound();
  if(user.activeCompanyId&&companyId!==user.activeCompanyId)return c.text("Forbidden",403);
  const partyTable=kind==="customer"?"customers":"suppliers",documentTable=kind==="customer"?"receivables":"payables",partyColumn=kind==="customer"?"customer_id":"supplier_id";
  const [identity,documents,advances]=await c.env.DB.batch([
    c.env.DB.prepare(`SELECT p.id,p.code,p.name,c.code company,c.name company_name FROM ${partyTable} p CROSS JOIN companies c WHERE p.id=? AND c.id=?`).bind(partyId,companyId),
    c.env.DB.prepare(`SELECT id,document_number,document_date,due_date,transaction_type,source_type,total_amount_paise,paid_amount_paise,balance_amount_paise,payment_status,remarks FROM ${documentTable} WHERE company_id=? AND ${partyColumn}=? AND balance_amount_paise>0 ORDER BY document_date,document_number,id LIMIT 501`).bind(companyId,partyId),
    c.env.DB.prepare(`SELECT id,payment_date,payment_type,mode,reference_number,total_amount_paise,allocated_amount_paise,unallocated_amount_paise,remarks FROM payments WHERE company_id=? AND ${partyColumn}=? AND unallocated_amount_paise>0 ORDER BY payment_date,id LIMIT 501`).bind(companyId,partyId),
  ]);
  const party=identity?.results?.[0] as Row|undefined;if(!party)return c.notFound();
  const docs=(documents?.results??[]) as Row[],advanceRows=(advances?.results??[]) as Row[];
  const total=docs.reduce((sum,row)=>sum+Number(row.total_amount_paise??0),0),documentPaid=docs.reduce((sum,row)=>sum+Number(row.paid_amount_paise??0),0),documentBalance=docs.reduce((sum,row)=>sum+Number(row.balance_amount_paise??0),0),advance=advanceRows.reduce((sum,row)=>sum+Number(row.unallocated_amount_paise??0),0),offset=Math.min(documentBalance,advance),closing=Math.max(documentBalance-advance,0);
  const summary=`<section class="metric-grid"><article class="metric-card"><span>Bill total</span><strong>₹${money(total)}</strong></article><article class="metric-card"><span>Document paid</span><strong>₹${money(documentPaid)}</strong></article><article class="metric-card"><span>Advance offset</span><strong>₹${money(offset)}</strong><small>₹${money(Math.max(advance-offset,0))} remains open</small></article><article class="metric-card danger"><span>Closing outstanding</span><strong>₹${money(closing)}</strong></article></section>`;
  const docRows=docs.slice(0,500).map(row=>[escapeHtml(row.document_number),escapeHtml(row.document_date),escapeHtml(row.due_date),escapeHtml(row.transaction_type??row.source_type),money(row.total_amount_paise),money(row.paid_amount_paise),money(row.balance_amount_paise),escapeHtml(row.payment_status),escapeHtml(row.remarks)]);
  const paymentRows=advanceRows.slice(0,500).map(row=>[escapeHtml(row.payment_date),escapeHtml(row.payment_type),escapeHtml(row.mode),escapeHtml(row.reference_number),money(row.total_amount_paise),money(row.allocated_amount_paise),money(row.unallocated_amount_paise)]);
  const warning=(docs.length>500||advanceRows.length>500)?'<p class="flash warning">More than 500 detail rows exist; use exports for a narrowed period.</p>':"";
  return c.html(layout(`${kind==="customer"?"Customer":"Supplier"} Outstanding`, `<p><strong>${escapeHtml(party.name)}</strong> · ${escapeHtml(party.company)} ${escapeHtml(party.company_name)}</p>${summary}${warning}<h2>Open documents</h2>${table(["Document","Date","Due","Type","Total","Document paid","Document balance","Status","Remarks"],docRows)}<h2>Unallocated advances</h2>${table(["Date","Type","Mode","Reference","Original","Allocated","Unallocated"],paymentRows)}`,user));
}

financeRead.get("/outstanding",listing);
financeRead.get("/outstanding/customer/:companyId/:customerId",(c)=>detail(c,"customer"));
financeRead.get("/outstanding/supplier/:companyId/:supplierId",(c)=>detail(c,"supplier"));

export default financeRead;
