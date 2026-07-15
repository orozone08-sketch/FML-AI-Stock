import { Hono } from "hono";
import type { Action, AppVariables, Env } from "../types";
import { can } from "../security/permissions";
import { escapeHtml, formField, layout, table } from "../views/html";
import { nowIso } from "../db/helpers";
import { normalizeFilters, toCsv, toPdf, toXlsx } from "../reports";

interface MasterConfig { table: string; module: string; title: string; columns: string[]; form: string[]; companyScoped?: boolean; dbColumns?: Record<string,string> }
const configs: Record<string, MasterConfig> = {
  items: { table: "items", module: "items", title: "Items", columns: ["code", "name", "unit", "hsn", "gst_basis_points", "minimum_stock_milliunits", "active"], form: ["code", "name", "unit", "hsn", "gst_percent", "minimum_stock", "notes"], dbColumns: { gst_percent: "gst_basis_points", minimum_stock: "minimum_stock_milliunits" } },
  customers: { table: "customers", module: "customers", title: "Customers", columns: ["code", "name", "contact_person", "mobile", "city", "active"], form: ["code", "name", "contact_person", "customer_type", "gst_number", "mobile", "whatsapp", "email", "address", "city", "state", "default_credit_days", "notes"] },
  suppliers: { table: "suppliers", module: "suppliers", title: "Suppliers", columns: ["code", "name", "mobile", "email", "active"], form: ["code", "name", "gst_number", "mobile", "email", "address", "default_credit_days"] },
  companies: { table: "companies", module: "companies", title: "Companies", columns: ["code", "name", "gst_number", "allow_gst_purchase", "allow_cash_purchase", "allow_gst_sale", "allow_cash_sale", "active"], form: ["code", "name", "gst_number", "allow_gst_purchase", "allow_cash_purchase", "allow_gst_sale", "allow_cash_sale"] },
  "stock-books": { table: "stock_books", module: "stock_books", title: "Stock Books", columns: ["code", "name", "company_id", "book_type", "active"], form: ["company_id", "code", "name", "book_type"], companyScoped: true },
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
  if (field === "gst_percent" || field === "minimum_stock") return `<label>${escapeHtml(field.replaceAll("_"," "))}<input name="${field}" type="number" min="0" step="${field === "gst_percent" ? "0.01" : "0.001"}" value="${escapeHtml(formValue(field,row))}"></label>`;
  const numeric = field === "gst_percent" || field === "minimum_stock" || field === "default_credit_days";
  return formField(field, field.replaceAll("_", " "), formValue(field,row), field === "email" ? "email" : numeric ? "number" : "text", ["code", "name"].includes(field));
}
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

masters.get("/:kind", async (c) => {
  const item = config(c.req.param("kind"));
  if (!item) return c.notFound();
  if (!authorized(c, item, "view")) return c.text("Forbidden", 403);
  const user = c.get("user")!;
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const active = c.req.query("active") ?? "active";
  const where: string[] = []; const values: unknown[] = [];
  if (active === "active") where.push("active=1"); else if (active === "inactive") where.push("active=0");
  if (q) { where.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)"); values.push(`${q}%`, `${q}%`); }
  if (item.companyScoped && user.activeCompanyId) { where.push("company_id=?"); values.push(user.activeCompanyId); }
  const sql = `SELECT id,${item.columns.join(",")} FROM ${item.table}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY code,id LIMIT 101`;
  const rows = (await c.env.DB.prepare(sql).bind(...values).all<Record<string, unknown>>()).results;
  const rendered = rows.slice(0, 100).map((row) => item.columns.map((column) => escapeHtml(column === "gst_basis_points" ? Number(row[column] ?? 0) / 100 : column === "minimum_stock_milliunits" ? Number(row[column] ?? 0) / 1000 : row[column])).concat(`${authorized(c,item,"edit") ? `<a href="/masters/${c.req.param("kind")}/${row.id}/edit">Edit</a> ` : ""}${authorized(c,item,"deactivate") && row.active ? `<form class="inline-form" method="post" action="/masters/${c.req.param("kind")}/${row.id}/deactivate"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><button type="submit">Deactivate</button></form>` : ""}${c.req.param("kind") === "customers" && authorized(c,item,"deactivate") ? `<form class="inline-form" method="post" action="/masters/customers/${row.id}/delete"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><button type="submit">Delete</button></form>` : ""}`));
  const controls = `<form method="get"><input name="q" value="${escapeHtml(q)}" placeholder="Search code or name"><select name="active"><option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option></select><button>Find</button></form>${authorized(c, item, "create") ? `<p><a class="button" href="/masters/${c.req.param("kind")}/new">New ${escapeHtml(item.title.replace(/s$/, ""))}</a></p>` : ""}`;
  return c.html(layout(item.title, controls + table([...item.columns, "Actions"], rendered), user));
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
  const companyValues=filters.companyId?[filters.companyId]:[];
  const customer=c.env.DB.prepare("SELECT id,code,name,contact_person,customer_type,gst_number,mobile,whatsapp,email,address,city,state,default_credit_days,active,notes FROM customers WHERE id=?").bind(customerId);
  const opening=c.env.DB.prepare(`SELECT COALESCE((SELECT SUM(total_amount_paise) FROM receivables WHERE customer_id=? AND document_date<?${companyClause}),0)-COALESCE((SELECT SUM(total_amount_paise) FROM payments WHERE customer_id=? AND payment_date<?${companyClause}),0) opening_paise`).bind(customerId,filters.from,...companyValues,customerId,filters.from,...companyValues);
  const entries=c.env.DB.prepare(`SELECT e.date,e.kind,e.particulars,e.reference,e.debit_paise,e.credit_paise,e.remarks,e.id FROM (SELECT document_date date,source_type kind,CASE WHEN is_opening=1 THEN 'To Opening Balance' WHEN source_type='SALE' THEN 'To Sales '||COALESCE(transaction_type,'') ELSE 'To '||source_type END particulars,document_number reference,total_amount_paise debit_paise,0 credit_paise,COALESCE(remarks,'') remarks,id*2 id FROM receivables WHERE customer_id=? AND document_date BETWEEN ? AND ?${companyClause} UNION ALL SELECT payment_date,payment_type,CASE WHEN payment_type='OPENING_ADVANCE_RECEIVED' THEN 'By Opening Advance' ELSE 'By '||COALESCE(mode,'Receipt') END,COALESCE(reference_number,'PAY-'||id),0,total_amount_paise,COALESCE(remarks,''),id*2+1 FROM payments WHERE customer_id=? AND payment_date BETWEEN ? AND ?${companyClause}) e ORDER BY e.date,e.id LIMIT 2001`).bind(customerId,filters.from,filters.to,...companyValues,customerId,filters.from,filters.to,...companyValues);
  const results=await c.env.DB.batch([customer,opening,entries]);
  const customerRow=results[0]?.results?.[0] as Record<string,unknown>|undefined;if(!customerRow)return null;
  const openingPaise=Number((results[1]?.results?.[0] as Record<string,unknown>|undefined)?.opening_paise??0);
  let running=openingPaise,periodDebit=0,periodCredit=0;
  const period=(results[2]?.results??[]).slice(0,2000).map((entry:any)=>{periodDebit+=Number(entry.debit_paise??0);periodCredit+=Number(entry.credit_paise??0);running+=Number(entry.debit_paise??0)-Number(entry.credit_paise??0);return{...entry,running_balance_paise:running};});
  const rows=[{date:filters.from,kind:"OPENING",particulars:"Opening Balance",reference:"",debit_paise:openingPaise>0?openingPaise:0,credit_paise:openingPaise<0?-openingPaise:0,running_balance_paise:openingPaise,is_opening:true},...period];
  return {customer:customerRow,rows,from:filters.from,to:filters.to,opening_paise:openingPaise,period_debit_paise:periodDebit,period_credit_paise:periodCredit,closing_paise:running,truncated:(results[2]?.results?.length??0)>2000};
}

function balance(value:unknown):string { const amount=Number(value??0);return `${(Math.abs(amount)/100).toFixed(2)}${amount===0?"":amount>0?" Dr":" Cr"}`; }
function statementRows(statement:any):Record<string,unknown>[] { return statement.rows.map((row:any)=>({Date:row.date,Particulars:row.particulars,"Voucher type":row.kind,"Voucher no.":row.reference,debit_paise:row.debit_paise,credit_paise:row.credit_paise,Balance:balance(row.running_balance_paise)})); }
function statementBody(statement:any):string { const rows=statement.rows.map((row:any)=>[escapeHtml(row.date),escapeHtml(row.particulars),escapeHtml(row.kind),escapeHtml(row.reference),(Number(row.debit_paise??0)/100).toFixed(2),(Number(row.credit_paise??0)/100).toFixed(2),escapeHtml(balance(row.running_balance_paise))]);return `<form method="get" class="inline-filters"><label>From<input type="date" name="date_from" value="${escapeHtml(statement.from)}"></label><label>To<input type="date" name="date_to" value="${escapeHtml(statement.to)}"></label><button>Apply</button></form><section class="metric-grid"><article class="metric-card"><span>Opening</span><strong>${escapeHtml(balance(statement.opening_paise))}</strong></article><article class="metric-card"><span>Period debit</span><strong>${(statement.period_debit_paise/100).toFixed(2)}</strong></article><article class="metric-card"><span>Period credit</span><strong>${(statement.period_credit_paise/100).toFixed(2)}</strong></article><article class="metric-card"><span>Closing</span><strong>${escapeHtml(balance(statement.closing_paise))}</strong></article></section>${statement.truncated?'<p class="flash warning">Statement exceeds 2,000 period entries; narrow the date range before exporting.</p>':""}${table(["Date","Particulars","Voucher type","Voucher no.","Debit","Credit","Balance"],rows)}`; }

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
  if(statement.truncated)return c.text("Statement exceeds 2,000 entries; narrow the date range",413);
  const rows=statementRows(statement),base=`customer-${Number(c.req.param("customerId"))}`;
  if(fmt==="xlsx")return new Response(toXlsx(rows,String(statement.customer.name)),{headers:{"content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","content-disposition":`attachment; filename="${base}.xlsx"`}});
  if(fmt==="pdf")return new Response(toPdf(`${statement.customer.name} Ledger Account`,rows),{headers:{"content-type":"application/pdf","content-disposition":`attachment; filename="${base}.pdf"`}});
  return new Response(toCsv(rows),{headers:{"content-type":"text/csv; charset=utf-8","content-disposition":`attachment; filename="${base}.csv"`}});
});

masters.get("/suppliers/:supplierId/transactions",async(c)=>{
  if(!can(c.get("user"),"suppliers","view"))return c.text("Forbidden",403);
  const id=Number(c.req.param("supplierId")),user=c.get("user")!,scope=scopedCompany(user,"p.company_id");
  const supplier=await c.env.DB.prepare("SELECT id,code,name,gst_number,mobile,email,address,active FROM suppliers WHERE id=?").bind(id).first<Record<string,unknown>>();if(!supplier)return c.notFound();
  const rows=await c.env.DB.prepare(`SELECT p.bill_date,p.bill_number,p.grand_total_paise,p.balance_amount_paise,p.payment_status FROM purchases p WHERE p.supplier_id=? AND p.is_void=0${scope.clause} ORDER BY p.bill_date DESC,p.id DESC LIMIT 200`).bind(id,...scope.values).all<Record<string,unknown>>();
  return c.html(layout(`${supplier.name} Transactions`,table(["Date","Bill","Amount","Balance","Status"],rows.results.map(r=>[escapeHtml(r.bill_date),escapeHtml(r.bill_number),escapeHtml((Number(r.grand_total_paise)/100).toFixed(2)),escapeHtml((Number(r.balance_amount_paise)/100).toFixed(2)),escapeHtml(r.payment_status)])),user));
});

masters.get("/:kind/new", async (c) => {
  const item = config(c.req.param("kind")); if (!item) return c.notFound(); if (!authorized(c, item, "create")) return c.text("Forbidden", 403);
  const user = c.get("user")!;
  return c.html(layout(`New ${item.title.replace(/s$/, "")}`, `<form method="post"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}">${item.form.map((field) => masterField(item,field)).join("")}<label><input type="checkbox" name="active" value="1" checked> Active</label><button>Save</button></form>`, user));
});

masters.post("/:kind/new", async (c) => {
  const item = config(c.req.param("kind")); if (!item) return c.notFound(); if (!authorized(c, item, "create")) return c.text("Forbidden", 403);
  const body = await c.req.parseBody(); const user = c.get("user")!; const now = nowIso();
  const columns = [...item.form.map((field)=>dbColumn(item,field)), "active", "created_at", "updated_at", "created_by_id"];
  const values = await masterValues(c, item, body); if (!values) return c.text("Invalid or inactive company", 400);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO ${item.table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).bind(...values, body.active === "1" ? 1 : 0, now, now, user.id),
      c.env.DB.prepare("INSERT INTO audit_logs(user_id,company_id,action,entity_type,reference,created_at) VALUES(?,?,'create',?,?,?)").bind(user.id, user.activeCompanyId, item.title, String(body.code ?? ""), now),
    ]);
  } catch (error) { return c.html(layout(`New ${item.title}`, `<p>Could not save: ${escapeHtml(error instanceof Error ? error.message : error)}</p>`, user), 409); }
  return c.redirect(`/masters/${c.req.param("kind")}`, 303);
});

masters.get("/:kind/:id/edit", async (c) => {
  const item = config(c.req.param("kind")); if (!item) return c.notFound(); if (!authorized(c, item, "edit")) return c.text("Forbidden", 403);
  const user = c.get("user")!;
  const scope = masterScope(item, user); const id = Number.parseInt(c.req.param("id"), 10); const row = await c.env.DB.prepare(`SELECT * FROM ${item.table} WHERE id=?${scope.clause}`).bind(id, ...scope.values).first<Record<string, unknown>>(); if (!row) return c.notFound();
  return c.html(layout(`Edit ${item.title.replace(/s$/, "")}`, `<form method="post"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}">${item.form.map((field) => masterField(item,field,row)).join("")}<label><input type="checkbox" name="active" value="1" ${row.active ? "checked" : ""}> Active</label><button>Save</button></form>`, user));
});

masters.post("/:kind/:id/edit", async (c) => {
  const item = config(c.req.param("kind")); if (!item) return c.notFound(); if (!authorized(c, item, "edit")) return c.text("Forbidden", 403);
  const id = Number.parseInt(c.req.param("id"), 10); const body = await c.req.parseBody(); const user = c.get("user")!; const now = nowIso();
  const scope = masterScope(item, user); const existing = await c.env.DB.prepare(`SELECT * FROM ${item.table} WHERE id=?${scope.clause}`).bind(id, ...scope.values).first<Record<string, unknown>>(); if (!existing) return c.notFound();
  const values = await masterValues(c, item, body, existing); if (!values) return c.text("Invalid or inactive company", 400);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE ${item.table} SET ${item.form.map((field) => `${dbColumn(item,field)}=?`).join(",")},active=?,updated_at=?,updated_by_id=? WHERE id=?${scope.clause}`).bind(...values, body.active === "1" ? 1 : 0, now, user.id, id, ...scope.values),
    c.env.DB.prepare("INSERT INTO audit_logs(user_id,company_id,action,entity_type,entity_id,created_at) VALUES(?,?,'edit',?,?,?)").bind(user.id, user.activeCompanyId, item.title, String(id), now),
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
  const row = await c.env.DB.prepare(`SELECT id${item.companyScoped ? ",company_id" : ""} FROM ${item.table} WHERE id=?${scope.clause}`).bind(id, ...scope.values).first<Record<string,unknown>>(); if (!row) return c.notFound();
  const now=nowIso(); await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE ${item.table} SET active=0,updated_at=?,updated_by_id=? WHERE id=?${scope.clause}`).bind(now, user.id, id, ...scope.values),
    c.env.DB.prepare("INSERT INTO audit_logs(user_id,company_id,action,entity_type,entity_id,created_at) VALUES(?,?,'deactivate',?,?,?)").bind(user.id,row.company_id ?? user.activeCompanyId,item.title,String(id),now),
  ]);
  return c.redirect(`/masters/${c.req.param("kind")}`, 303);
});

export default masters;
