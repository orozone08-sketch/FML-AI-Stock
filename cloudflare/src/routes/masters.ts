import { Hono } from "hono";
import type { Action, AppVariables, Env } from "../types";
import { can } from "../security/permissions";
import { escapeHtml, formField, layout, table } from "../views/html";
import { nowIso } from "../db/helpers";
import { normalizeFilters, toCsv, toPdf, toXlsx } from "../reports";

interface MasterConfig { table: string; module: string; title: string; description:string; columns: string[]; form: string[]; companyScoped?: boolean; dbColumns?: Record<string,string> }
const configs: Record<string, MasterConfig> = {
  items: { table: "items", module: "items", title: "Items", description:"Maintain item codes, GST rates, units, and minimum stock levels.", columns: ["code", "name", "unit", "hsn", "gst_basis_points", "minimum_stock_milliunits", "active"], form: ["code", "name", "unit", "hsn", "gst_percent", "minimum_stock", "notes"], dbColumns: { gst_percent: "gst_basis_points", minimum_stock: "minimum_stock_milliunits" } },
  customers: { table: "customers", module: "customers", title: "Customers", description:"Search customer and supplier master records with full transaction drilldowns.", columns: ["code", "name", "customer_type", "gst_number", "mobile", "default_credit_days", "active"], form: ["code", "name", "contact_person", "customer_type", "gst_number", "mobile", "whatsapp", "email", "address", "city", "state", "default_credit_days", "notes"] },
  suppliers: { table: "suppliers", module: "suppliers", title: "Suppliers", description:"Maintain supplier contact details and default credit days.", columns: ["code", "name", "gst_number", "mobile", "default_credit_days", "active"], form: ["code", "name", "gst_number", "mobile", "email", "address", "default_credit_days"] },
  companies: { table: "companies", module: "companies", title: "Companies", description:"Company transaction rules for FML and AI.", columns: ["code", "name", "gst_number", "allow_gst_purchase", "allow_cash_purchase", "allow_gst_sale", "allow_cash_sale", "active"], form: ["code", "name", "gst_number", "allow_gst_purchase", "allow_cash_purchase", "allow_gst_sale", "allow_cash_sale"] },
  "stock-books": { table: "stock_books", module: "stock_books", title: "Stock Books", description:"Segregated GST and cash stock pools by company.", columns: ["code", "name", "company_id", "book_type", "active"], form: ["company_id", "code", "name", "book_type"], companyScoped: true },
};

const masters = new Hono<{ Bindings: Env; Variables: AppVariables }>();

function config(kind: string): MasterConfig | null { return configs[kind] ?? null; }
function authorized(c: any, item: MasterConfig, action: Action): boolean { return can(c.get("user"), item.module, action); }
function normalize(value: unknown): string | number | null { const text = String(value ?? "").trim(); return text === "" ? null : text; }
const booleanFields = new Set(["allow_gst_purchase", "allow_cash_purchase", "allow_gst_sale", "allow_cash_sale"]);
function dbColumn(item: MasterConfig, field: string): string { return item.dbColumns?.[field] ?? field; }
function formValue(field: string, row: Record<string,unknown>): unknown {
  if (field === "gst_percent") return Number(row.gst_basis_points ?? 0) / 100;
  if (field === "minimum_stock") return Number(row.minimum_stock_milliunits ?? 0) / 1000;
  return row[field] ?? "";
}
function masterField(item: MasterConfig, field: string, row: Record<string,unknown> = {}): string {
  if (booleanFields.has(field)) return `<label><input type="checkbox" name="${field}" value="1" ${row[field] || !("id" in row) && field.startsWith("allow_gst") ? "checked" : ""}> ${escapeHtml(field.replaceAll("_", " "))}</label>`;
  if(field==="customer_type")return `<label>Customer type<select name="customer_type"><option value="CASH" ${row.customer_type==="CASH"?"selected":""}>CASH</option><option value="BILL" ${row.customer_type==="BILL"?"selected":""}>BILL</option><option value="CASH_AND_BILL" ${!['CASH','BILL'].includes(String(row.customer_type))?"selected":""}>CASH_AND_BILL</option></select></label>`;
  if(field==="book_type")return `<label>Book type<select name="book_type"><option value="GST" ${row.book_type!=="CASH"?"selected":""}>GST</option><option value="CASH" ${row.book_type==="CASH"?"selected":""}>CASH</option></select></label>`;
  if(["notes","address"].includes(field))return `<label class="full-span">${escapeHtml(field.replaceAll("_"," "))}<textarea name="${field}">${escapeHtml(formValue(field,row))}</textarea></label>`;
  if (field === "gst_percent" || field === "minimum_stock") return `<label>${escapeHtml(field.replaceAll("_"," "))}<input name="${field}" type="number" min="0" step="${field === "gst_percent" ? "0.01" : "0.001"}" value="${escapeHtml(formValue(field,row))}"></label>`;
  const numeric = field === "gst_percent" || field === "minimum_stock" || field === "default_credit_days";
  return formField(field, field.replaceAll("_", " "), formValue(field,row), field === "email" ? "email" : numeric ? "number" : "text", ["code", "name"].includes(field));
}
function pageNumber(raw:string|undefined):number { const value=Number(raw??1);return Number.isSafeInteger(value)&&value>0?value:1; }
function pagination(path:string,page:number,total:number,perPage:number,params:URLSearchParams):string { const pages=Math.max(1,Math.ceil(total/perPage));if(pages<=1)return "";const link=(target:number,label:string)=>{const next=new URLSearchParams(params);next.set("page",String(target));return `<a class="secondary-button" href="${path}?${escapeHtml(next.toString())}">${label}</a>`};return `<div class="pagination">${page>1?link(page-1,"Previous"):""}<span>Page ${page} of ${pages}</span>${page<pages?link(page+1,"Next"):""}</div>`; }
async function masterForm(c:any,item:MasterConfig,row:Record<string,unknown>={}):Promise<string>{const user=c.get("user")!,kind=c.req.param("kind");let fields=item.form.map(field=>masterField(item,field,row));if(kind==="stock-books"){const companies=((await c.env.DB.prepare("SELECT id,code,name FROM companies WHERE active=1 ORDER BY code").all()).results??[]) as Record<string,unknown>[];fields=fields.map((field,index)=>item.form[index]==="company_id"?`<label>Company<select name="company_id" required>${companies.map((company:Record<string,unknown>)=>`<option value="${company.id}" ${Number(company.id)===Number(row.company_id)?"selected":""}>${escapeHtml(company.code)} - ${escapeHtml(company.name)}</option>`).join("")}</select></label>`:field);}return `<section class="panel narrow"><form method="post" class="form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}">${fields.join("")}<label class="check full-span"><input name="active" type="checkbox" value="1" ${row.active!==0?"checked":""}> Active</label><div class="form-actions full-span"><a class="secondary-button" href="/masters/${kind}">Cancel</a><button class="primary-button" type="submit">Save</button></div></form></section>`;}
function masterScope(item: MasterConfig, user: { activeCompanyId: number | null }): { clause: string; values: number[] } {
  return item.companyScoped && user.activeCompanyId ? { clause: " AND company_id=?", values: [user.activeCompanyId] } : { clause: "", values: [] };
}

async function masterValues(c: any, item: MasterConfig, body: Record<string, unknown>, existing?: Record<string, unknown>): Promise<Array<string | number | null> | null> {
  const user = c.get("user")!;
  const values = item.form.map((field) => {
    if (booleanFields.has(field)) return body[field] === "1" ? 1 : 0;
    if (field === "gst_percent") return Math.round(Number(body[field] ?? 0) * 100);
    if (field === "minimum_stock") return Math.round(Number(body[field] ?? 0) * 1000);
    return normalize(body[field]);
  });
  if (item.table === "items") {
    const gst=Number(values[item.form.indexOf("gst_percent")]),minimum=Number(values[item.form.indexOf("minimum_stock")]);
    if(!Number.isFinite(gst)||gst<0||gst>10000||!Number.isFinite(minimum)||minimum<0)return null;
  }
  if (!item.companyScoped) return values;
  const index = item.form.indexOf("company_id");
  const companyId = user.activeCompanyId ?? Number(values[index] ?? existing?.company_id);
  if (!Number.isSafeInteger(companyId) || companyId <= 0) return null;
  if (existing && Number(existing.company_id) !== companyId) return null;
  const company = await c.env.DB.prepare("SELECT id FROM companies WHERE id=? AND active=1").bind(companyId).first();
  if (!company) return null;
  values[index] = companyId;
  return values;
}

masters.get("/", (c) => c.redirect("/masters/items", 303));

async function customerDirectory(c:any,item:MasterConfig):Promise<Response>{
  const user=c.get("user")!,page=pageNumber(c.req.query("page")),perPage=25,q=(c.req.query("q")??"").trim().toLowerCase(),active=c.req.query("active")??"active";
  const requested=c.req.query("company_id"),companyId=user.activeCompanyId??(requested&&/^\d+$/.test(requested)?Number(requested):null);
  const activeSql=active==="active"?" AND party_active=1":active==="inactive"?" AND party_active=0":"",companySql=companyId?" AND (company_ids IS NULL OR ','||company_ids||',' LIKE ?)":"",searchSql=q?" AND LOWER(search_text||' '||COALESCE(company_label,'')) LIKE ?":"";
  const values:unknown[]=[...(companyId?[`%,${companyId},%`]:[]),...(q?[`%${q}%`]:[])];
  const base=`WITH linked AS (SELECT 'customer' kind,customer_id party_id,company_id FROM sales WHERE customer_id IS NOT NULL AND is_void=0 UNION SELECT 'customer',customer_id,company_id FROM receivables WHERE customer_id IS NOT NULL UNION SELECT 'customer',customer_id,company_id FROM payments WHERE customer_id IS NOT NULL UNION SELECT 'supplier',supplier_id,company_id FROM purchases WHERE supplier_id IS NOT NULL AND is_void=0 UNION SELECT 'supplier',supplier_id,company_id FROM payables WHERE supplier_id IS NOT NULL UNION SELECT 'supplier',supplier_id,company_id FROM payments WHERE supplier_id IS NOT NULL), parties AS (SELECT 'customer' kind,id,code,name,contact_person,mobile,gst_number,city,active party_active,LOWER(code||' '||name||' '||COALESCE(contact_person,'')||' '||COALESCE(mobile,'')||' '||COALESCE(gst_number,'')||' '||COALESCE(city,'')) search_text FROM customers UNION ALL SELECT 'supplier',id,code,name,NULL,mobile,gst_number,NULL,active,LOWER(code||' '||name||' '||COALESCE(mobile,'')||' '||COALESCE(gst_number,'')) FROM suppliers), directory AS (SELECT p.*,GROUP_CONCAT(DISTINCT l.company_id) company_ids,GROUP_CONCAT(DISTINCT co.code) company_label FROM parties p LEFT JOIN linked l ON l.kind=p.kind AND l.party_id=p.id LEFT JOIN companies co ON co.id=l.company_id GROUP BY p.kind,p.id) `;
  const where=`WHERE 1=1${activeSql}${companySql}${searchSql}`;
  const [countResult,rowResult,companyResult]=await c.env.DB.batch([c.env.DB.prepare(`${base}SELECT COUNT(*) total FROM directory ${where}`).bind(...values),c.env.DB.prepare(`${base}SELECT * FROM directory ${where} ORDER BY LOWER(name),kind,id LIMIT ? OFFSET ?`).bind(...values,perPage,(page-1)*perPage),c.env.DB.prepare("SELECT id,code,name FROM companies WHERE active=1 ORDER BY code")]);
  const total=Number((countResult?.results?.[0] as any)?.total??0),rows=(rowResult?.results??[]) as Record<string,unknown>[],companies=(companyResult?.results??[]) as Record<string,unknown>[];
  const companyOptions=`${user.activeCompanyId?"":"<option value=''>All companies</option>"}${companies.map(row=>`<option value="${row.id}" ${Number(row.id)===companyId?"selected":""}>${escapeHtml(row.code)} - ${escapeHtml(row.name)}</option>`).join("")}`;
  const params=new URL(c.req.url).searchParams;params.delete("page");
  const rendered=rows.map(row=>{const customer=row.kind==="customer",detail=customer?`/masters/customers/${row.id}${companyId?`?company_id=${companyId}`:""}`:`/masters/suppliers/${row.id}/transactions${companyId?`?company_id=${companyId}`:""}`,module=customer?"customers":"suppliers";const actions=`<div class="action-menu" data-action-menu><button class="table-action action-menu-toggle icon-only" type="button" data-action-menu-toggle aria-haspopup="true" aria-expanded="false" aria-label="Actions" title="Actions"><span data-icon="more-horizontal"></span></button><div class="action-menu-list" role="menu"><a href="${detail}" role="menuitem">Transactions</a><a href="${detail}" role="menuitem">View Details</a>${customer?`<a href="/masters/customers/${row.id}/print" role="menuitem">Overall Print</a><a href="/masters/customers/${row.id}/export/pdf" role="menuitem">Overall PDF</a>`:`<a href="/masters/suppliers?q=${encodeURIComponent(String(row.name))}" role="menuitem">Open Supplier</a>`}${can(user,module,"edit")?`<a href="/masters/${module}/${row.id}/edit" role="menuitem">Edit</a>`:""}${customer&&can(user,"customers","deactivate")?`<form method="post" action="/masters/customers/${row.id}/delete" data-confirm="Delete this customer profile? If it has transactions, it will be deactivated to keep history safe."><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><button type="submit" role="menuitem">Delete</button></form>`:""}</div></div>`;return [escapeHtml(row.company_label??"All"),`<a class="customer-link" href="${detail}">${escapeHtml(row.name)}</a><small class="customer-subtext">${customer?"Customer":"Supplier"} · ${escapeHtml(row.code)}${row.mobile?` · ${escapeHtml(row.mobile)}`:""}${row.city?` · ${escapeHtml(row.city)}`:""}${row.gst_number?` · GST ${escapeHtml(row.gst_number)}`:""}</small>`,`<span class="status ${row.party_active?"ok":"muted"}">${row.party_active?(customer?"Active":"Supplier"):(customer?"Inactive":"Inactive supplier")}</span>`,escapeHtml(row.contact_person),escapeHtml(row.mobile),escapeHtml(row.gst_number),escapeHtml(row.city),actions]});
  const controls=`<section class="panel"><form class="toolbar" method="get" data-live-search-form><input name="q" placeholder="Search customer/supplier, company, mobile, GST, city" value="${escapeHtml(q)}" autocomplete="off" data-live-search data-live-target="#customers_table"><select name="company_id" ${user.activeCompanyId?"disabled":""}>${companyOptions}</select>${user.activeCompanyId?`<input type="hidden" name="company_id" value="${user.activeCompanyId}">`:""}<select name="active"><option value="active" ${active==="active"?"selected":""}>Active</option><option value="inactive" ${active==="inactive"?"selected":""}>Inactive</option><option value="all" ${active==="all"?"selected":""}>All</option></select><button class="secondary-button" type="submit" data-live-find>Find</button>${can(user,"customers","create")?'<a class="primary-button" href="/masters/customers/new">Add</a>':""}</form></section>`;
  const body=`${controls}<section class="panel"><div class="panel-title"><h2>Customer / Supplier Directory</h2><span class="muted-copy">${total} record${total===1?"":"s"}</span></div><div class="table-wrap enterprise-table-wrap"><table id="customers_table" class="enterprise-table customer-directory-table" data-sticky-columns="3">${table(["Company","Party","Status","Contact","Mobile","GST","City","Actions"],rendered).replace(/^<table>|<\/table>$/g,"")}</table></div>${pagination("/masters/customers",page,total,perPage,params)}</section>`;
  return c.html(layout(item.title,body,user));
}

masters.get("/:kind", async (c) => {
  const item = config(c.req.param("kind"));
  if (!item) return c.notFound();
  if (!authorized(c, item, "view")) return c.text("Forbidden", 403);
  if(c.req.param("kind")==="customers")return customerDirectory(c,item);
  const user = c.get("user")!;
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const active = c.req.query("active") ?? "active";
  const where: string[] = []; const values: unknown[] = [];
  if (active === "active") where.push("active=1"); else if (active === "inactive") where.push("active=0");
  if (q) { where.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)"); values.push(`${q}%`, `${q}%`); }
  if (item.companyScoped && user.activeCompanyId) { where.push("company_id=?"); values.push(user.activeCompanyId); }
  const page=pageNumber(c.req.query("page")),perPage=50,whereSql=where.length?` WHERE ${where.join(" AND ")}`:"";
  const [countResult,rowResult]=await c.env.DB.batch([c.env.DB.prepare(`SELECT COUNT(*) total FROM ${item.table}${whereSql}`).bind(...values),c.env.DB.prepare(`SELECT id,${item.columns.join(",")} FROM ${item.table}${whereSql} ORDER BY code,id LIMIT ? OFFSET ?`).bind(...values,perPage,(page-1)*perPage)]);const rows=(rowResult?.results??[]) as Record<string,unknown>[],total=Number((countResult?.results?.[0] as any)?.total??0);
  const rendered = rows.map((row) => item.columns.map((column) => column==="active"?`<span class="status ${row.active?"ok":"muted"}">${row.active?"Active":"Inactive"}</span>`:escapeHtml(column === "gst_basis_points" ? Number(row[column] ?? 0) / 100 : column === "minimum_stock_milliunits" ? Number(row[column] ?? 0) / 1000 : row[column])).concat(`<div class="action-menu" data-action-menu><button class="table-action action-menu-toggle icon-only" type="button" data-action-menu-toggle aria-haspopup="true" aria-expanded="false" aria-label="Actions" title="Actions"><span data-icon="more-horizontal"></span></button><div class="action-menu-list" role="menu">${c.req.param("kind")==="suppliers"?`<a href="/masters/suppliers/${row.id}/transactions" role="menuitem">Transactions</a><a href="/masters/suppliers/${row.id}/transactions" role="menuitem">View Details</a>`:""}${authorized(c,item,"edit")?`<a href="/masters/${c.req.param("kind")}/${row.id}/edit" role="menuitem">Edit</a>`:""}${authorized(c,item,"deactivate")&&row.active?`<form method="post" action="/masters/${c.req.param("kind")}/${row.id}/deactivate" data-confirm="Deactivate this record?"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><button type="submit" role="menuitem">Deactivate</button></form>`:""}</div></div>`));
  const controls = `<section class="panel"><form class="toolbar" method="get" data-live-search-form><input name="q" value="${escapeHtml(q)}" placeholder="Search" autocomplete="off" data-live-search data-live-target="#${c.req.param("kind")}_table"><select name="active"><option value="active" ${active==="active"?"selected":""}>Active</option><option value="inactive" ${active==="inactive"?"selected":""}>Inactive</option><option value="all" ${active==="all"?"selected":""}>All</option></select><button class="secondary-button" type="submit" data-live-find>Find</button>${authorized(c,item,"create")?`<a class="primary-button" href="/masters/${c.req.param("kind")}/new">Add</a>`:""}</form><div class="table-wrap enterprise-table-wrap"><table id="${c.req.param("kind")}_table" class="enterprise-table">${table([...item.columns.map(column=>column.replaceAll("_"," ")),"Actions"],rendered).replace(/^<table>|<\/table>$/g,"")}</table></div>${pagination(`/masters/${c.req.param("kind")}`,page,total,perPage,new URL(c.req.url).searchParams)}</section>`;
  return c.html(layout(item.title, controls, user));
});

function scopedCompany(user: any, column: string): { clause: string; values: number[] } {
  return user.activeCompanyId ? { clause: ` AND ${column}=?`, values: [user.activeCompanyId] } : { clause: "", values: [] };
}

async function customerStatement(c: any, customerId: number) {
  const user=c.get("user")!;
  const current=new Date().toISOString().slice(0,10),year=Number(current.slice(0,4))-(Number(current.slice(5,7))<4?1:0);
  const companyRaw=c.req.query("company_id"),requestedCompany=companyRaw===undefined?undefined:Number(companyRaw);
  const filters=normalizeFilters({from:c.req.query("date_from")||`${year}-04-01`,to:c.req.query("date_to")||current,...(requestedCompany!==undefined?{companyId:requestedCompany}:{})},{activeCompanyId:user.activeCompanyId});
  const companyClause=filters.companyId?" AND company_id=?":"";
  const saleCompanyClause=filters.companyId?" AND s.company_id=?":"";
  const paymentCompanyClause=filters.companyId?" AND p.company_id=?":"";
  const companyValues=filters.companyId?[filters.companyId]:[];
  const customer=c.env.DB.prepare("SELECT id,code,name,contact_person,customer_type,gst_number,mobile,whatsapp,email,address,city,state,default_credit_days,active,notes FROM customers WHERE id=?").bind(customerId);
  const opening=c.env.DB.prepare(`SELECT COALESCE((SELECT SUM(total_amount_paise) FROM receivables WHERE customer_id=? AND document_date<?${companyClause}),0)-COALESCE((SELECT SUM(total_amount_paise) FROM payments WHERE customer_id=? AND payment_date<?${companyClause}),0) opening_paise`).bind(customerId,filters.from,...companyValues,customerId,filters.from,...companyValues);
  const entries=c.env.DB.prepare(`SELECT e.date,e.kind,e.particulars,e.reference,e.debit_paise,e.credit_paise,e.remarks,e.id FROM (SELECT document_date date,source_type kind,CASE WHEN is_opening=1 THEN 'To Opening Balance' WHEN source_type='SALE' THEN 'To Sales '||COALESCE(transaction_type,'') ELSE 'To '||source_type END particulars,document_number reference,total_amount_paise debit_paise,0 credit_paise,COALESCE(remarks,'') remarks,id*2 id FROM receivables WHERE customer_id=? AND document_date BETWEEN ? AND ?${companyClause} UNION ALL SELECT payment_date,payment_type,CASE WHEN payment_type='OPENING_ADVANCE_RECEIVED' THEN 'By Opening Advance' ELSE 'By '||COALESCE(mode,'Receipt') END,COALESCE(reference_number,'PAY-'||id),0,total_amount_paise,COALESCE(remarks,''),id*2+1 FROM payments WHERE customer_id=? AND payment_date BETWEEN ? AND ?${companyClause}) e ORDER BY e.date,e.id`).bind(customerId,filters.from,filters.to,...companyValues,customerId,filters.from,filters.to,...companyValues);
  const companies=c.env.DB.prepare(`SELECT DISTINCT co.id,co.code,co.name FROM companies co JOIN (SELECT company_id FROM sales WHERE customer_id=? AND is_void=0 UNION SELECT company_id FROM receivables WHERE customer_id=? UNION SELECT company_id FROM payments WHERE customer_id=?) linked ON linked.company_id=co.id${filters.companyId?" WHERE co.id=?":""} ORDER BY co.code`).bind(customerId,customerId,customerId,...companyValues);
  const sales=c.env.DB.prepare(`SELECT s.id,s.company_id,co.code company,s.invoice_number,s.invoice_date,s.due_date,s.sale_type,s.grand_total_paise,s.paid_amount_paise,s.balance_amount_paise,s.payment_status,s.remarks FROM sales s JOIN companies co ON co.id=s.company_id WHERE s.customer_id=? AND s.is_void=0 AND s.invoice_date BETWEEN ? AND ?${saleCompanyClause} ORDER BY s.invoice_date DESC,s.id DESC`).bind(customerId,filters.from,filters.to,...companyValues);
  const payments=c.env.DB.prepare(`SELECT p.id,p.company_id,co.code company,p.payment_date,p.mode,p.total_amount_paise,p.allocated_amount_paise,p.unallocated_amount_paise,p.reference_number,p.remarks FROM payments p JOIN companies co ON co.id=p.company_id WHERE p.customer_id=? AND p.payment_date BETWEEN ? AND ?${paymentCompanyClause} ORDER BY p.payment_date DESC,p.id DESC`).bind(customerId,filters.from,filters.to,...companyValues);
  const stock=c.env.DB.prepare(`SELECT sl.id,s.id sale_id,s.invoice_number challan_number,s.invoice_date challan_date,s.payment_status,i.code item_code,i.name item_name,i.unit,sl.quantity_milliunits FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id JOIN items i ON i.id=sl.item_id WHERE s.customer_id=? AND s.is_void=0 AND s.invoice_date BETWEEN ? AND ?${saleCompanyClause} ORDER BY s.invoice_date DESC,s.id DESC,sl.id`).bind(customerId,filters.from,filters.to,...companyValues);
  const results=await c.env.DB.batch([customer,opening,entries,companies,sales,payments,stock]);
  const customerRow=results[0]?.results?.[0] as Record<string,unknown>|undefined;if(!customerRow)return null;
  const openingPaise=Number((results[1]?.results?.[0] as Record<string,unknown>|undefined)?.opening_paise??0);
  let running=openingPaise,periodDebit=0,periodCredit=0;
  const period=(results[2]?.results??[]).map((entry:any)=>{periodDebit+=Number(entry.debit_paise??0);periodCredit+=Number(entry.credit_paise??0);running+=Number(entry.debit_paise??0)-Number(entry.credit_paise??0);return{...entry,running_balance_paise:running};});
  const rows=[{date:filters.from,kind:"OPENING",particulars:"Opening Balance",reference:"",debit_paise:openingPaise>0?openingPaise:0,credit_paise:openingPaise<0?-openingPaise:0,running_balance_paise:openingPaise,is_opening:true},...period];
  const saleRows=(results[4]?.results??[]) as Record<string,unknown>[],paymentRows=(results[5]?.results??[]) as Record<string,unknown>[],stockRows=(results[6]?.results??[]) as Record<string,unknown>[];
  const totalSales=saleRows.reduce((sum,row)=>sum+Number(row.grand_total_paise??0),0),totalReceived=paymentRows.reduce((sum,row)=>sum+Number(row.total_amount_paise??0),0);
  const stockGiven=stockRows.reduce((sum,row)=>sum+Number(row.quantity_milliunits??0),0),pendingStock=stockRows.reduce((sum,row)=>row.payment_status==="PAID"?sum:sum+Number(row.quantity_milliunits??0),0);
  const lastTransaction=[...saleRows.map(row=>String(row.invoice_date??"")),...paymentRows.map(row=>String(row.payment_date??""))].sort().at(-1)??"";
  const lastPayment=paymentRows.map(row=>String(row.payment_date??"")).sort().at(-1)??"";
  return {customer:customerRow,rows,companies:results[3]?.results??[],sales:saleRows,payments:paymentRows,stock:stockRows,summary:{total_sales_paise:totalSales,total_received_paise:totalReceived,total_pending_paise:running,stock_given_milliunits:stockGiven,pending_stock_milliunits:pendingStock,last_transaction:lastTransaction,last_payment:lastPayment},from:filters.from,to:filters.to,opening_paise:openingPaise,period_debit_paise:periodDebit,period_credit_paise:periodCredit,closing_paise:running};
}

function balance(value:unknown):string { const amount=Number(value??0);return `${(Math.abs(amount)/100).toFixed(2)}${amount===0?"":amount>0?" Dr":" Cr"}`; }
function customerExportRows(profile:any):Record<string,unknown>[] {
  const customer=profile.customer,companies=profile.companies.map((row:any)=>row.code).join(", ")||"All";
  const moneyCell=(value:unknown)=>(Number(value??0)/100).toFixed(2);
  const rows:Record<string,unknown>[]=[
    {Section:"Summary","Date / Field":"Period","Total / Debit":profile.from,"Paid / Credit":profile.to,Details:`Companies: ${companies}`},
    {Section:"Summary","Date / Field":"Total Sales","Total / Debit":moneyCell(profile.summary.total_sales_paise),Details:`${profile.sales.length} invoice(s)`},
    {Section:"Summary","Date / Field":"Received","Total / Debit":moneyCell(profile.summary.total_received_paise),Details:`Last payment: ${profile.summary.last_payment||"-"}`},
    {Section:"Summary","Date / Field":"Pending Payment","Total / Debit":moneyCell(profile.summary.total_pending_paise),Details:`Last transaction: ${profile.summary.last_transaction||"-"}`},
    {Section:"Summary","Date / Field":"Pending Stock","Total / Debit":qty(profile.summary.pending_stock_milliunits)},
    {Section:"Customer","Date / Field":"Code","Total / Debit":customer.code},
    {Section:"Customer","Date / Field":"Name","Total / Debit":customer.name},
    {Section:"Customer","Date / Field":"Contact","Total / Debit":customer.contact_person??"","Paid / Credit":customer.mobile??"","Balance / Status":customer.whatsapp??""},
    {Section:"Customer","Date / Field":"Email / GST","Total / Debit":customer.email??"","Paid / Credit":customer.gst_number??""},
    {Section:"Customer","Date / Field":"City / State","Total / Debit":customer.city??"","Paid / Credit":customer.state??"",Details:customer.address??""},
    {Section:"Customer","Date / Field":"Notes","Total / Debit":customer.notes??""},
  ];
  for(const sale of profile.sales)rows.push({Section:"Invoice","Date / Field":sale.invoice_date,Document:sale.invoice_number,Type:sale.sale_type,"Total / Debit":moneyCell(sale.grand_total_paise),"Paid / Credit":moneyCell(sale.paid_amount_paise),"Balance / Status":`${moneyCell(sale.balance_amount_paise)} / ${sale.payment_status}`,Details:sale.remarks??""});
  for(const stock of profile.stock)rows.push({Section:"Stock / Challan","Date / Field":stock.challan_date,Document:stock.challan_number,Type:`${stock.item_code} - ${stock.item_name}`,"Total / Debit":qty(stock.quantity_milliunits),"Balance / Status":stock.payment_status==="PAID"?"Completed":"Pending",Details:`${qty(stock.quantity_milliunits)} ${stock.unit}`});
  for(const payment of profile.payments)rows.push({Section:"Payment","Date / Field":payment.payment_date,Document:payment.reference_number??"",Type:payment.mode,"Total / Debit":moneyCell(payment.total_amount_paise),"Paid / Credit":moneyCell(payment.allocated_amount_paise),"Balance / Status":moneyCell(payment.unallocated_amount_paise),Details:payment.remarks??""});
  for(const sale of profile.sales)rows.push({Section:"Document","Date / Field":sale.invoice_date,Document:`Invoice PDF - ${sale.invoice_number}`,Type:"Invoice PDF"});
  return rows;
}
function qty(value:unknown):string { const amount=Number(value??0)/1000;return amount.toLocaleString("en-IN",{maximumFractionDigits:3}); }
function statementBody(statement:any):string { const ledgerRows=statement.rows.map((row:any)=>[escapeHtml(row.date),escapeHtml(row.particulars),escapeHtml(row.kind),escapeHtml(row.reference),(Number(row.debit_paise??0)/100).toFixed(2),(Number(row.credit_paise??0)/100).toFixed(2),escapeHtml(balance(row.running_balance_paise))]);const sales=statement.sales.map((row:any)=>[escapeHtml(row.invoice_date),escapeHtml(row.company),`<a href="/transactions/sale/${row.id}/view">${escapeHtml(row.invoice_number)}</a>`,escapeHtml(row.sale_type),(Number(row.grand_total_paise)/100).toFixed(2),(Number(row.paid_amount_paise)/100).toFixed(2),(Number(row.balance_amount_paise)/100).toFixed(2),escapeHtml(row.payment_status),`<a href="/transactions/sale/${row.id}/view">View</a> <a href="/transactions/sale/${row.id}/edit">Edit</a> <a href="/transactions/sale/${row.id}/export/pdf">PDF</a>`]);const stock=statement.stock.map((row:any)=>[`<a href="/transactions/sale/${row.sale_id}/view">${escapeHtml(row.challan_number)}</a>`,escapeHtml(row.challan_date),escapeHtml(`${row.item_code} - ${row.item_name} (${row.unit})`),escapeHtml(qty(row.quantity_milliunits)),escapeHtml(`${qty(row.quantity_milliunits)} ${row.unit}`),row.payment_status==="PAID"?"Completed":"Pending",`<a href="/transactions/sale/${row.sale_id}/view">View</a> <a href="/transactions/sale/${row.sale_id}/export/pdf">PDF</a>`]);const payments=statement.payments.map((row:any)=>[escapeHtml(row.payment_date),escapeHtml(row.company),escapeHtml(row.mode),(Number(row.total_amount_paise)/100).toFixed(2),(Number(row.allocated_amount_paise)/100).toFixed(2),(Number(row.unallocated_amount_paise)/100).toFixed(2),escapeHtml(row.reference_number),escapeHtml(row.remarks),`<a href="/finance/payments/${row.id}/export/pdf">PDF</a> <a href="/finance/payments/${row.id}/print">Print</a>`]);const companies=statement.companies.map((row:any)=>row.code).join(", ")||"-";return `<form method="get" class="inline-filters"><a href="/masters/customers">Customers</a><label>From<input type="date" name="date_from" value="${escapeHtml(statement.from)}"></label><label>To<input type="date" name="date_to" value="${escapeHtml(statement.to)}"></label><button>Apply</button></form><section class="metric-grid"><article class="metric-card"><span>Total Sales</span><strong>${(statement.summary.total_sales_paise/100).toFixed(2)}</strong><small>${statement.sales.length} invoices</small></article><article class="metric-card danger"><span>Pending Payment</span><strong>${(statement.summary.total_pending_paise/100).toFixed(2)}</strong></article><article class="metric-card amber"><span>Pending Stock</span><strong>${escapeHtml(qty(statement.summary.pending_stock_milliunits))}</strong></article><article class="metric-card"><span>Last Transaction</span><strong>${escapeHtml(statement.summary.last_transaction||"-")}</strong><small>Last payment ${escapeHtml(statement.summary.last_payment||"-")}</small></article></section><nav class="tab-nav"><a href="#overview">Overview</a><a href="#invoices">Invoices</a><a href="#challans">Challans</a><a href="#stock">Stock</a><a href="#payments">Payments</a><a href="#documents">Notes / Documents</a><a href="#ledger">Ledger</a></nav><section class="panel" id="overview"><h2>Overview</h2><div class="detail-grid"><div><span>Customer name</span><strong>${escapeHtml(statement.customer.name)}</strong></div><div><span>Company</span><strong>${escapeHtml(companies)}</strong></div><div><span>Contact person</span><strong>${escapeHtml(statement.customer.contact_person||"-")}</strong></div><div><span>Mobile</span><strong>${escapeHtml(statement.customer.mobile||"-")}</strong></div><div><span>WhatsApp</span><strong>${escapeHtml(statement.customer.whatsapp||"-")}</strong></div><div><span>Email</span><strong>${escapeHtml(statement.customer.email||"-")}</strong></div><div><span>GST number</span><strong>${escapeHtml(statement.customer.gst_number||"-")}</strong></div><div><span>City / State</span><strong>${escapeHtml([statement.customer.city,statement.customer.state].filter(Boolean).join(", ")||"-")}</strong></div><div class="full-span"><span>Address</span><strong>${escapeHtml(statement.customer.address||"-")}</strong></div><div class="full-span"><span>Notes</span><strong>${escapeHtml(statement.customer.notes||"-")}</strong></div></div></section><section class="panel" id="invoices"><h2>Invoices</h2>${table(["Date","Company","Invoice","Type","Total","Paid","Pending","Status","Actions"],sales)}</section><section class="panel" id="challans"><h2>Challans</h2>${table(["Challan No.","Challan Date","Item","Quantity","Weight","Status","Actions"],stock)}</section><section class="panel" id="stock"><h2>Stock</h2><div class="metric-grid"><article class="metric-card"><span>Stock Given</span><strong>${escapeHtml(qty(statement.summary.stock_given_milliunits))}</strong></article><article class="metric-card"><span>Stock Received Back</span><strong>0</strong></article><article class="metric-card amber"><span>Pending Stock</span><strong>${escapeHtml(qty(statement.summary.pending_stock_milliunits))}</strong></article></div></section><section class="panel" id="payments"><h2>Payments</h2>${table(["Date","Company","Mode","Amount","Allocated","Unallocated","Reference","Remarks","Actions"],payments)}</section><section class="panel" id="documents"><h2>Notes / Documents</h2>${table(["Date","Type","Document","Actions"],statement.sales.map((row:any)=>[escapeHtml(row.invoice_date),"Invoice PDF",`<a href="/transactions/sale/${row.id}/view">Invoice PDF - ${escapeHtml(row.invoice_number)}</a>`,`<a href="/transactions/sale/${row.id}/export/pdf">Open PDF</a>`]))}</section><section class="panel" id="ledger"><h2>Account Statement</h2><section class="metric-grid"><article class="metric-card"><span>Opening</span><strong>${escapeHtml(balance(statement.opening_paise))}</strong></article><article class="metric-card"><span>Period debit</span><strong>${(statement.period_debit_paise/100).toFixed(2)}</strong></article><article class="metric-card"><span>Period credit</span><strong>${(statement.period_credit_paise/100).toFixed(2)}</strong></article><article class="metric-card"><span>Closing</span><strong>${escapeHtml(balance(statement.closing_paise))}</strong></article></section>${table(["Date","Particulars","Voucher type","Voucher no.","Debit","Credit","Balance"],ledgerRows)}</section>`; }

masters.get("/customers/:customerId",async(c)=>{
  if(!can(c.get("user"),"customers","view"))return c.text("Forbidden",403);
  let statement;try{statement=await customerStatement(c,Number(c.req.param("customerId")));}catch(error){return c.text(error instanceof Error?error.message:"Invalid statement filters",400);}if(!statement)return c.notFound();
  const query=new URL(c.req.url).search;return c.html(layout(String(statement.customer.name),`<p>${escapeHtml(statement.customer.code)} · ${escapeHtml(statement.customer.mobile)} · ${escapeHtml(statement.customer.gst_number)}</p><nav class="inline-actions"><a href="${c.req.path}/print${escapeHtml(query)}">Print</a><a href="${c.req.path}/export/csv${escapeHtml(query)}">CSV</a><a href="${c.req.path}/export/xlsx${escapeHtml(query)}">XLSX</a><a href="${c.req.path}/export/pdf${escapeHtml(query)}">PDF</a></nav>${statementBody(statement)}`,c.get("user")));
});

masters.get("/customers/:customerId/print",async(c)=>{
  if(!can(c.get("user"),"customers","view"))return c.text("Forbidden",403);
  let statement;try{statement=await customerStatement(c,Number(c.req.param("customerId")));}catch(error){return c.text(error instanceof Error?error.message:"Invalid statement filters",400);}if(!statement)return c.notFound();
  return c.html(layout(`${statement.customer.name} Statement`,statementBody(statement),c.get("user"),{scripts:"<span hidden data-auto-print></span>"}));
});

masters.get("/customers/:customerId/export/:fmt",async(c)=>{
  if(!can(c.get("user"),"customers","export"))return c.text("Forbidden",403);
  const fmt=c.req.param("fmt");if(!["csv","xlsx","pdf"].includes(fmt))return c.text("Unsupported format",400);
  let statement;try{statement=await customerStatement(c,Number(c.req.param("customerId")));}catch(error){return c.text(error instanceof Error?error.message:"Invalid statement filters",400);}if(!statement)return c.notFound();
  const rows=customerExportRows(statement),base=`customer-${Number(c.req.param("customerId"))}`;
  if(fmt==="xlsx")return new Response(toXlsx(rows,String(statement.customer.name)),{headers:{"content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","content-disposition":`attachment; filename="${base}.xlsx"`}});
  if(fmt==="pdf")return new Response(toPdf(`${statement.customer.name} Ledger Account`,rows),{headers:{"content-type":"application/pdf","content-disposition":`attachment; filename="${base}.pdf"`}});
  return new Response(toCsv(rows),{headers:{"content-type":"text/csv; charset=utf-8","content-disposition":`attachment; filename="${base}.csv"`}});
});

masters.get("/suppliers/:supplierId/transactions",async(c)=>{
  if(!can(c.get("user"),"suppliers","view"))return c.text("Forbidden",403);
  const id=Number(c.req.param("supplierId")),user=c.get("user")!,requested=c.req.query("company_id"),companyId=user.activeCompanyId??(requested&&/^\d+$/.test(requested)?Number(requested):undefined);
  let filters;try{const rawFrom=c.req.query("date_from"),rawTo=c.req.query("date_to");filters=normalizeFilters({...(rawFrom?{from:rawFrom}:{}),...(rawTo?{to:rawTo}:{}),...(companyId?{companyId}:{})},{activeCompanyId:user.activeCompanyId});}catch(error){return c.text(error instanceof Error?error.message:"Invalid filters",400);}const current=new Date().toISOString().slice(0,10),year=Number(current.slice(0,4))-(Number(current.slice(5,7))<4?1:0),from=filters.from??`${year}-04-01`,to=filters.to??current,scope=companyId?" AND company_id=?":"",values=companyId?[companyId]:[];
  const [supplierResult,companiesResult,purchasesResult,payablesResult,paymentsResult]=await c.env.DB.batch([c.env.DB.prepare("SELECT id,code,name,gst_number,mobile,email,address,default_credit_days,active FROM suppliers WHERE id=?").bind(id),c.env.DB.prepare("SELECT id,code,name FROM companies WHERE active=1 ORDER BY code"),c.env.DB.prepare(`SELECT p.id,p.company_id,co.code company,p.bill_date,p.bill_number,p.purchase_type,p.grand_total_paise,p.paid_amount_paise,p.balance_amount_paise,p.payment_status FROM purchases p JOIN companies co ON co.id=p.company_id WHERE p.supplier_id=? AND p.is_void=0 AND p.bill_date BETWEEN ? AND ?${companyId?" AND p.company_id=?":""} ORDER BY p.bill_date DESC,p.id DESC`).bind(id,from,to,...values),c.env.DB.prepare(`SELECT id,company_id,document_date,due_date,document_number,source_type,total_amount_paise,paid_amount_paise,balance_amount_paise,payment_status,is_opening FROM payables WHERE supplier_id=? AND document_date BETWEEN ? AND ?${scope} ORDER BY document_date,id`).bind(id,from,to,...values),c.env.DB.prepare(`SELECT p.id,p.company_id,co.code company,p.payment_date,p.mode,p.reference_number,p.total_amount_paise,p.allocated_amount_paise,p.unallocated_amount_paise FROM payments p JOIN companies co ON co.id=p.company_id WHERE p.supplier_id=? AND p.payment_date BETWEEN ? AND ?${companyId?" AND p.company_id=?":""} ORDER BY p.payment_date DESC,p.id DESC`).bind(id,from,to,...values)]);
  const supplier=supplierResult?.results?.[0] as Record<string,unknown>|undefined;if(!supplier)return c.notFound();const purchases=(purchasesResult?.results??[]) as any[],payables=(payablesResult?.results??[]) as any[],payments=(paymentsResult?.results??[]) as any[];
  const totalPurchase=purchases.reduce((sum,row)=>sum+Number(row.grand_total_paise??0),0),totalPaid=payments.reduce((sum,row)=>sum+Number(row.total_amount_paise??0),0),totalPending=payables.reduce((sum,row)=>sum+Number(row.balance_amount_paise??0),0);let running=0;const activity=[...payables.map(row=>({date:row.document_date,particulars:row.is_opening?"To Opening Balance":"To Purchase",type:row.is_opening?"Opening":row.source_type,reference:row.document_number,debit:Number(row.total_amount_paise),credit:0,id:Number(row.id)*2})),...payments.map(row=>({date:row.payment_date,particulars:`By ${row.mode||"Payment"}`,type:"SUPPLIER_PAYMENT",reference:row.reference_number||`PAY-${row.id}`,debit:0,credit:Number(row.total_amount_paise),id:Number(row.id)*2+1}))].sort((a,b)=>a.date.localeCompare(b.date)||a.id-b.id).map(row=>({...row,balance:(running+=row.debit-row.credit)}));
  const money=(value:unknown)=>(Number(value??0)/100).toFixed(2),companyOptions=`${user.activeCompanyId?"":"<option value=''>All companies</option>"}${(companiesResult?.results??[]).map((row:any)=>`<option value="${row.id}" ${Number(row.id)===companyId?"selected":""}>${escapeHtml(row.code)} - ${escapeHtml(row.name)}</option>`).join("")}`;
  const controls=`<section class="panel"><form class="toolbar" method="get"><a class="secondary-button" href="/masters/suppliers">Suppliers</a><select name="company_id" ${user.activeCompanyId?"disabled":""}>${companyOptions}</select>${user.activeCompanyId?`<input type="hidden" name="company_id" value="${user.activeCompanyId}">`:""}<input type="date" name="date_from" value="${from}" aria-label="Period from"><input type="date" name="date_to" value="${to}" aria-label="Period to"><button class="secondary-button" type="submit">Apply</button><a class="secondary-button" href="/masters/suppliers/${id}/transactions${companyId?`?company_id=${companyId}`:""}">This FY</a><span class="spacer"></span><span class="muted-copy">Period ${from} to ${to}</span>${can(user,"suppliers","edit")?`<a class="primary-button" href="/masters/suppliers/${id}/edit">Edit Supplier</a>`:""}</form></section>`;
  const metrics=`<section class="metric-grid"><article class="metric-card"><span>Total Purchases</span><strong>${money(totalPurchase)}</strong><small>${purchases.length} bills</small></article><article class="metric-card amber"><span>Total Paid</span><strong>${money(totalPaid)}</strong><small>Payments and advances paid</small></article><article class="metric-card danger"><span>Pending Payable</span><strong>${money(totalPending)}</strong><small>Current supplier balance</small></article><article class="metric-card"><span>Last Transaction</span><strong>${escapeHtml([...purchases.map(r=>r.bill_date),...payments.map(r=>r.payment_date)].sort().at(-1)||"-")}</strong><small>Last payment ${escapeHtml(payments.map(r=>r.payment_date).sort().at(-1)||"-")}</small></article></section>`;
  const body=`${controls}${metrics}<nav class="tab-nav"><a href="#supplier-activity">Activity</a><a href="#supplier-purchases">Purchases</a><a href="#supplier-payables">Payables</a><a href="#supplier-payments">Payments</a></nav><section class="panel" id="supplier-activity"><h2>Activity Till Date</h2>${table(["Date","Particulars","Voucher type","Voucher no.","Debit","Credit","Balance"],activity.map(r=>[r.date,r.particulars,r.type,r.reference,r.debit?money(r.debit):"",r.credit?money(r.credit):"",money(r.balance)]))}</section><section class="panel" id="supplier-purchases"><h2>Purchase Bills</h2>${table(["Date","Company","Bill","Type","Total","Paid","Balance","Status","Actions"],purchases.map(r=>[r.bill_date,r.company,r.bill_number,r.purchase_type,money(r.grand_total_paise),money(r.paid_amount_paise),money(r.balance_amount_paise),r.payment_status,`<a href="/transactions/purchase/${r.id}/edit">Edit</a> <a href="/transactions/purchase/${r.id}/export/pdf">PDF</a> <a href="/transactions/purchase/${r.id}/print">Print</a>`]))}</section><section class="panel" id="supplier-payables"><h2>Payables / Opening Bills</h2>${table(["Date","Due","Document","Source","Total","Paid","Balance","Status"],payables.map(r=>[r.document_date,r.due_date,r.document_number,r.is_opening?"Opening":r.source_type,money(r.total_amount_paise),money(r.paid_amount_paise),money(r.balance_amount_paise),r.payment_status]))}</section><section class="panel" id="supplier-payments"><h2>Payments / Advances</h2>${table(["Date","Company","Mode","Amount","Allocated","Advance","Reference","Actions"],payments.map(r=>[r.payment_date,r.company,r.mode,money(r.total_amount_paise),money(r.allocated_amount_paise),money(r.unallocated_amount_paise),r.reference_number,`<a href="/finance/payments/${r.id}/edit">Edit</a> <a href="/finance/payments/${r.id}/export/pdf">PDF</a> <a href="/finance/payments/${r.id}/print">Print</a>`]))}</section>`;
  return c.html(layout(String(supplier.name),body,user));
});

masters.get("/:kind/new", async (c) => {
  const item = config(c.req.param("kind")); if (!item) return c.notFound(); if (!authorized(c, item, "create")) return c.text("Forbidden", 403);
  const user = c.get("user")!;
  return c.html(layout(`Add ${item.title.replace(/s$/, "")}`,await masterForm(c,item), user));
});

masters.post("/:kind/new", async (c) => {
  const item = config(c.req.param("kind")); if (!item) return c.notFound(); if (!authorized(c, item, "create")) return c.text("Forbidden", 403);
  const body = await c.req.parseBody(); const user = c.get("user")!; const now = nowIso();
  const columns = [...item.form.map((field)=>dbColumn(item,field)), "active", "created_at", "updated_at", "created_by_id"];
  const values = await masterValues(c, item, body); if (!values) return c.text("Invalid or inactive company", 400);
  try {
    const result=await c.env.DB.prepare(`INSERT INTO ${item.table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).bind(...values, body.active === "1" ? 1 : 0, now, now, user.id).run();
    await c.env.DB.prepare("INSERT INTO audit_logs(user_id,company_id,action,entity_type,entity_id,reference,after_values,created_at) VALUES(?,?,'create',?,?,?,?,?)").bind(user.id,user.activeCompanyId,item.title,String(result.meta.last_row_id),String(body.code??""),JSON.stringify(Object.fromEntries(columns.map((column,index)=>[column,[...values,body.active==="1"?1:0,now,now,user.id][index]]))),now).run();
  } catch (error) { return c.html(layout(`New ${item.title}`, `<p>Could not save: ${escapeHtml(error instanceof Error ? error.message : error)}</p>`, user), 409); }
  return c.redirect(`/masters/${c.req.param("kind")}`, 303);
});

masters.get("/:kind/:id/edit", async (c) => {
  const item = config(c.req.param("kind")); if (!item) return c.notFound(); if (!authorized(c, item, "edit")) return c.text("Forbidden", 403);
  const user = c.get("user")!;
  const scope = masterScope(item, user); const id = Number.parseInt(c.req.param("id"), 10); const row = await c.env.DB.prepare(`SELECT * FROM ${item.table} WHERE id=?${scope.clause}`).bind(id, ...scope.values).first<Record<string, unknown>>(); if (!row) return c.notFound();
  return c.html(layout(`Edit ${item.title.replace(/s$/, "")}`,await masterForm(c,item,row), user));
});

masters.post("/:kind/:id/edit", async (c) => {
  const item = config(c.req.param("kind")); if (!item) return c.notFound(); if (!authorized(c, item, "edit")) return c.text("Forbidden", 403);
  const id = Number.parseInt(c.req.param("id"), 10); const body = await c.req.parseBody(); const user = c.get("user")!; const now = nowIso();
  const scope = masterScope(item, user); const existing = await c.env.DB.prepare(`SELECT * FROM ${item.table} WHERE id=?${scope.clause}`).bind(id, ...scope.values).first<Record<string, unknown>>(); if (!existing) return c.notFound();
  const values = await masterValues(c, item, body, existing); if (!values) return c.text("Invalid or inactive company", 400);
  const after={...existing,...Object.fromEntries(item.form.map((field,index)=>[dbColumn(item,field),values[index]])),active:body.active==="1"?1:0,updated_at:now,updated_by_id:user.id};
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE ${item.table} SET ${item.form.map((field) => `${dbColumn(item,field)}=?`).join(",")},active=?,updated_at=?,updated_by_id=? WHERE id=?${scope.clause}`).bind(...values, body.active === "1" ? 1 : 0, now, user.id, id, ...scope.values),
    c.env.DB.prepare("INSERT INTO audit_logs(user_id,company_id,action,entity_type,entity_id,reference,before_values,after_values,created_at) VALUES(?,?,'edit',?,?,?,?,?,?)").bind(user.id,user.activeCompanyId,item.title,String(id),String(existing.code??""),JSON.stringify(existing),JSON.stringify(after),now),
  ]);
  return c.redirect(`/masters/${c.req.param("kind")}`, 303);
});

masters.post("/customers/:id/delete", async (c) => {
  const user=c.get("user")!;
  if(!can(user,"customers","deactivate"))return c.text("Forbidden",403);
  const id=Number.parseInt(c.req.param("id"),10);
  const customer=await c.env.DB.prepare("SELECT id,code FROM customers WHERE id=?").bind(id).first<Record<string,unknown>>();
  if(!customer)return c.notFound();
  const used=await c.env.DB.prepare(`SELECT CASE WHEN
    EXISTS(SELECT 1 FROM sales WHERE customer_id=? AND is_void=0) OR
    EXISTS(SELECT 1 FROM receivables WHERE customer_id=?) OR
    EXISTS(SELECT 1 FROM payments WHERE customer_id=?) THEN 1 ELSE 0 END used`).bind(id,id,id).first<{used:number}>();
  const now=nowIso(),action=used?.used ? "deactivate" : "delete";
  await c.env.DB.batch([
    used?.used
      ? c.env.DB.prepare("UPDATE customers SET active=0,updated_at=?,updated_by_id=? WHERE id=?").bind(now,user.id,id)
      : c.env.DB.prepare("DELETE FROM customers WHERE id=?").bind(id),
    c.env.DB.prepare("INSERT INTO audit_logs(user_id,company_id,action,entity_type,entity_id,reference,created_at) VALUES(?,?,?,?,?,?,?)").bind(user.id,user.activeCompanyId,action,"Customers",String(id),String(customer.code??""),now),
  ]);
  return c.redirect("/masters/customers",303);
});

masters.post("/:kind/:id/deactivate", async (c) => {
  const item = config(c.req.param("kind")); if (!item) return c.notFound(); if (!authorized(c, item, "deactivate")) return c.text("Forbidden", 403);
  const user = c.get("user")!; const scope = masterScope(item, user); const id = Number.parseInt(c.req.param("id"), 10);
  const row = await c.env.DB.prepare(`SELECT * FROM ${item.table} WHERE id=?${scope.clause}`).bind(id, ...scope.values).first<Record<string,unknown>>(); if (!row) return c.notFound();
  const now=nowIso(); await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE ${item.table} SET active=0,updated_at=?,updated_by_id=? WHERE id=?${scope.clause}`).bind(now, user.id, id, ...scope.values),
    c.env.DB.prepare("INSERT INTO audit_logs(user_id,company_id,action,entity_type,entity_id,reference,before_values,after_values,created_at) VALUES(?,?,'deactivate',?,?,?,?,?,?)").bind(user.id,row.company_id ?? user.activeCompanyId,item.title,String(id),String(row.code??""),JSON.stringify(row),JSON.stringify({...row,active:0,updated_at:now,updated_by_id:user.id}),now),
  ]);
  return c.redirect(`/masters/${c.req.param("kind")}`, 303);
});

export default masters;
