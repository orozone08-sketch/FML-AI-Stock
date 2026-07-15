import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { can } from "../security/permissions";
import { normalizeFilters, ReportRepository } from "../reports";
import { escapeHtml, layout, money, qty, table } from "../views/html";

const dashboard = new Hono<{ Bindings: Env; Variables: AppVariables }>();

function today():string { return new Date().toISOString().slice(0,10); }
function monthStart(value:string):string { return `${value.slice(0,7)}-01`; }
function scalar(results:D1Result<unknown>[],index:number,key:string):number { return Number((results[index]?.results?.[0] as Record<string,unknown>|undefined)?.[key]??0); }

dashboard.get("/", async (c) => {
  const user=c.get("user")!;
  if(!can(user,"dashboard","view"))return c.text("Forbidden",403);
  const current=today();
  let range;
  try { range=normalizeFilters({from:c.req.query("from")??monthStart(current),to:c.req.query("to")??current},{activeCompanyId:user.activeCompanyId}); }
  catch(error){return c.text(error instanceof Error?error.message:"Invalid dashboard range",400);}
  const companyPredicate=user.activeCompanyId?" AND company_id=?":"";
  const companyValues=user.activeCompanyId?[user.activeCompanyId]:[];
  const bind=(sql:string,...values:unknown[])=>c.env.DB.prepare(sql).bind(...values,...companyValues);
  const results=await c.env.DB.batch([
    bind(`SELECT COALESCE(SUM(quantity_milliunits),0) quantity,COALESCE(SUM(ledger_value_paise),0) value FROM inventory_balances WHERE 1=1${companyPredicate}`),
    bind(`SELECT COALESCE(SUM(balance_amount_paise),0) total,COUNT(*) count,SUM(CASE WHEN due_date<? THEN 1 ELSE 0 END) overdue FROM receivables WHERE balance_amount_paise>0${companyPredicate}`,current),
    bind(`SELECT COALESCE(SUM(balance_amount_paise),0) total,COUNT(*) count,SUM(CASE WHEN due_date<? THEN 1 ELSE 0 END) overdue FROM payables WHERE balance_amount_paise>0${companyPredicate}`,current),
    bind(`SELECT COUNT(*) count,COALESCE(SUM(grand_total_paise),0) total,COALESCE(SUM(gross_profit_paise),0) profit FROM sales WHERE is_void=0 AND invoice_date BETWEEN ? AND ?${companyPredicate}`,range.from,range.to),
    bind(`SELECT COUNT(*) count,COALESCE(SUM(grand_total_paise),0) total FROM purchases WHERE is_void=0 AND bill_date BETWEEN ? AND ?${companyPredicate}`,range.from,range.to),
    bind(`SELECT COUNT(*) count FROM stock_books sb CROSS JOIN items i LEFT JOIN inventory_balances b ON b.company_id=sb.company_id AND b.stock_book_id=sb.id AND b.item_id=i.id WHERE sb.active=1 AND i.active=1 AND COALESCE(b.quantity_milliunits,0)<=i.minimum_stock_milliunits${user.activeCompanyId?" AND sb.company_id=?":""}`),
    user.activeCompanyId
      ? c.env.DB.prepare("SELECT COALESCE(SUM(balance_amount_paise),0) total FROM inter_company_ledger_entries WHERE status='PENDING' AND (stock_owner_company_id=? OR stock_user_company_id=?)").bind(user.activeCompanyId,user.activeCompanyId)
      : c.env.DB.prepare("SELECT COALESCE(SUM(balance_amount_paise),0) total FROM inter_company_ledger_entries WHERE status='PENDING'"),
    c.env.DB.prepare(`SELECT month,SUM(sales_paise) sales_paise,SUM(purchases_paise) purchases_paise FROM (SELECT substr(invoice_date,1,7) month,SUM(grand_total_paise) sales_paise,0 purchases_paise FROM sales WHERE is_void=0 AND invoice_date BETWEEN ? AND ?${companyPredicate} GROUP BY substr(invoice_date,1,7) UNION ALL SELECT substr(bill_date,1,7),0,SUM(grand_total_paise) FROM purchases WHERE is_void=0 AND bill_date BETWEEN ? AND ?${companyPredicate} GROUP BY substr(bill_date,1,7)) trend GROUP BY month ORDER BY month DESC LIMIT 13`).bind(range.from,range.to,...companyValues,range.from,range.to,...companyValues),
    bind(`SELECT r.document_number,r.due_date,r.balance_amount_paise,c.code company,cu.name party FROM receivables r JOIN companies c ON c.id=r.company_id LEFT JOIN customers cu ON cu.id=r.customer_id WHERE r.balance_amount_paise>0 AND r.due_date<?${user.activeCompanyId?" AND r.company_id=?":""} ORDER BY r.due_date,r.id LIMIT 8`,current),
    bind(`SELECT p.document_number,p.due_date,p.balance_amount_paise,c.code company,s.name party FROM payables p JOIN companies c ON c.id=p.company_id LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.balance_amount_paise>0 AND p.due_date<?${user.activeCompanyId?" AND p.company_id=?":""} ORDER BY p.due_date,p.id LIMIT 8`,current),
    c.env.DB.prepare(`SELECT c.code company,sb.name stock_book,i.code item_code,i.name item,COALESCE(b.quantity_milliunits,0) quantity_milliunits,i.minimum_stock_milliunits FROM stock_books sb JOIN companies c ON c.id=sb.company_id CROSS JOIN items i LEFT JOIN inventory_balances b ON b.company_id=sb.company_id AND b.stock_book_id=sb.id AND b.item_id=i.id WHERE sb.active=1 AND i.active=1 AND COALESCE(b.quantity_milliunits,0)<=i.minimum_stock_milliunits${user.activeCompanyId?" AND sb.company_id=?":""} ORDER BY COALESCE(b.quantity_milliunits,0),i.code,sb.code LIMIT 8`).bind(...companyValues),
    user.activeCompanyId
      ? c.env.DB.prepare("SELECT oc.code owner,uc.code user,i.code item,l.quantity_milliunits,l.balance_amount_paise,l.due_date FROM inter_company_ledger_entries l JOIN companies oc ON oc.id=l.stock_owner_company_id JOIN companies uc ON uc.id=l.stock_user_company_id LEFT JOIN items i ON i.id=l.item_id WHERE l.status='PENDING' AND (l.stock_owner_company_id=? OR l.stock_user_company_id=?) ORDER BY l.due_date,l.id LIMIT 8").bind(user.activeCompanyId,user.activeCompanyId)
      : c.env.DB.prepare("SELECT oc.code owner,uc.code user,i.code item,l.quantity_milliunits,l.balance_amount_paise,l.due_date FROM inter_company_ledger_entries l JOIN companies oc ON oc.id=l.stock_owner_company_id JOIN companies uc ON uc.id=l.stock_user_company_id LEFT JOIN items i ON i.id=l.item_id WHERE l.status='PENDING' ORDER BY l.due_date,l.id LIMIT 8"),
  ]);
  const cards=`<form class="inline-filters" method="get"><label>From <input type="date" name="from" value="${escapeHtml(range.from)}"></label><label>To <input type="date" name="to" value="${escapeHtml(range.to)}"></label><button type="submit">Apply</button></form><section class="metric-grid">
    <article class="metric-card"><span>Inventory</span><h3>Current stock</h3><strong>${qty(scalar(results,0,"quantity"))}</strong><small>₹${money(scalar(results,0,"value"))} ledger value</small></article>
    <article class="metric-card danger"><span>Customer</span><h3>Receivables</h3><strong>₹${money(scalar(results,1,"total"))}</strong><small>${scalar(results,1,"count")} open · ${scalar(results,1,"overdue")} overdue</small></article>
    <article class="metric-card amber"><span>Supplier</span><h3>Payables</h3><strong>₹${money(scalar(results,2,"total"))}</strong><small>${scalar(results,2,"count")} open · ${scalar(results,2,"overdue")} overdue</small></article>
    <article class="metric-card"><span>Selected period</span><h3>Sales</h3><strong>₹${money(scalar(results,3,"total"))}</strong><small>${scalar(results,3,"count")} documents · ₹${money(scalar(results,3,"profit"))} gross profit</small></article>
    <article class="metric-card"><span>Selected period</span><h3>Purchases</h3><strong>₹${money(scalar(results,4,"total"))}</strong><small>${scalar(results,4,"count")} documents</small></article>
    <article class="metric-card amber"><span>Stock control</span><h3>Low/out stock</h3><strong>${scalar(results,5,"count")}</strong><small><a href="/reports/stock-alerts">Open alerts</a></small></article>
    <article class="metric-card"><span>Inter-company</span><h3>Pending balance</h3><strong>₹${money(scalar(results,6,"total"))}</strong><small><a href="/reports/inter-company">Open ledger</a></small></article>
  </section>`;
  const rows=(index:number)=>(results[index]?.results??[]) as Record<string,unknown>[];
  const trend=table(["Month","Sales","Purchases"],rows(7).map(row=>[escapeHtml(row.month),`₹${money(row.sales_paise)}`,`₹${money(row.purchases_paise)}`]));
  const overdueReceivables=table(["Company","Customer","Document","Due","Balance"],rows(8).map(row=>[escapeHtml(row.company),escapeHtml(row.party),escapeHtml(row.document_number),escapeHtml(row.due_date),`₹${money(row.balance_amount_paise)}`]));
  const overduePayables=table(["Company","Supplier","Document","Due","Balance"],rows(9).map(row=>[escapeHtml(row.company),escapeHtml(row.party),escapeHtml(row.document_number),escapeHtml(row.due_date),`₹${money(row.balance_amount_paise)}`]));
  const lowStock=table(["Company","Book","Item","Quantity","Minimum"],rows(10).map(row=>[escapeHtml(row.company),escapeHtml(row.stock_book),escapeHtml(`${row.item_code} - ${row.item}`),qty(row.quantity_milliunits),qty(row.minimum_stock_milliunits)]));
  const interCompany=table(["Owner","User","Item","Quantity","Balance","Due"],rows(11).map(row=>[escapeHtml(row.owner),escapeHtml(row.user),escapeHtml(row.item),qty(row.quantity_milliunits),`₹${money(row.balance_amount_paise)}`,escapeHtml(row.due_date)]));
  const detail=`<section class="dashboard-detail-grid"><div><h2>Period trend</h2>${trend}</div><div><h2>Critical customer dues</h2>${overdueReceivables}</div><div><h2>Critical supplier dues</h2>${overduePayables}</div><div><h2>Low and negative stock</h2>${lowStock}</div><div><h2>Pending inter-company</h2>${interCompany}</div></section>`;
  return c.html(layout("Dashboard",cards+detail,user));
});

dashboard.get("/calendar-events",async(c)=>{
  const user=c.get("user")!;
  if(!can(user,"dashboard","view"))return c.text("Forbidden",403);
  const start=c.req.query("start")??monthStart(today());
  const end=c.req.query("end")??new Date(Date.parse(`${start}T00:00:00Z`)+40*86_400_000).toISOString().slice(0,10);
  try {
    const events=await new ReportRepository(c.env.DB,{activeCompanyId:user.activeCompanyId}).calendar({from:start,to:end});
    return c.json({events,start,end});
  } catch(error){ return c.text(error instanceof Error?error.message:"Invalid calendar range",400); }
});

export default dashboard;
