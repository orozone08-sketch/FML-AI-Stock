import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { can } from "../security/permissions";
import { normalizeFilters, ReportRepository } from "../reports";
import { escapeHtml, layout, money, qty } from "../views/html";

const dashboard = new Hono<{ Bindings: Env; Variables: AppVariables }>();

function today():string { return new Date().toISOString().slice(0,10); }
function monthStart(value:string):string { return `${value.slice(0,7)}-01`; }
function scalar(results:D1Result<unknown>[],index:number,key:string):number { return Number((results[index]?.results?.[0] as Record<string,unknown>|undefined)?.[key]??0); }
function dashboardTable(headers:string[],rows:unknown[][],empty:string):string {
  return `<div class="table-wrap"><table><thead><tr>${headers.map(value=>`<th>${escapeHtml(value)}</th>`).join("")}</tr></thead><tbody>${rows.length?rows.map(row=>`<tr>${row.map(cell=>`<td>${cell==null?"":String(cell)}</td>`).join("")}</tr>`).join(""):`<tr><td colspan="${headers.length}" class="empty">${escapeHtml(empty)}</td></tr>`}</tbody></table></div>`;
}

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
  const metricSql=`SELECT
    (SELECT COALESCE(SUM(quantity_milliunits),0) FROM inventory_balances WHERE 1=1${companyPredicate}) inventory_quantity,
    (SELECT COALESCE(SUM(ledger_value_paise),0) FROM inventory_balances WHERE 1=1${companyPredicate}) inventory_value,
    (SELECT COALESCE(SUM(balance_amount_paise),0) FROM receivables WHERE balance_amount_paise>0${companyPredicate}) receivable_total,
    (SELECT COUNT(*) FROM receivables WHERE balance_amount_paise>0${companyPredicate}) receivable_count,
    (SELECT COUNT(*) FROM receivables WHERE balance_amount_paise>0 AND due_date<?${companyPredicate}) receivable_overdue,
    (SELECT COALESCE(SUM(balance_amount_paise),0) FROM payables WHERE balance_amount_paise>0${companyPredicate}) payable_total,
    (SELECT COUNT(*) FROM payables WHERE balance_amount_paise>0${companyPredicate}) payable_count,
    (SELECT COUNT(*) FROM payables WHERE balance_amount_paise>0 AND due_date<?${companyPredicate}) payable_overdue,
    (SELECT COUNT(*) FROM sales WHERE is_void=0 AND invoice_date BETWEEN ? AND ?${companyPredicate}) sales_count,
    (SELECT COALESCE(SUM(grand_total_paise),0) FROM sales WHERE is_void=0 AND invoice_date BETWEEN ? AND ?${companyPredicate}) sales_total,
    (SELECT COALESCE(SUM(gross_profit_paise),0) FROM sales WHERE is_void=0 AND invoice_date BETWEEN ? AND ?${companyPredicate}) sales_profit,
    (SELECT COUNT(*) FROM purchases WHERE is_void=0 AND bill_date BETWEEN ? AND ?${companyPredicate}) purchase_count,
    (SELECT COALESCE(SUM(grand_total_paise),0) FROM purchases WHERE is_void=0 AND bill_date BETWEEN ? AND ?${companyPredicate}) purchase_total,
    (SELECT COUNT(*) FROM stock_books sb CROSS JOIN items i LEFT JOIN inventory_balances b ON b.company_id=sb.company_id AND b.stock_book_id=sb.id AND b.item_id=i.id WHERE sb.active=1 AND i.active=1 AND COALESCE(b.quantity_milliunits,0)<=i.minimum_stock_milliunits${user.activeCompanyId?" AND sb.company_id=?":""}) low_stock_count,
    (SELECT COALESCE(SUM(balance_amount_paise),0) FROM inter_company_ledger_entries WHERE status='PENDING'${user.activeCompanyId?" AND (stock_owner_company_id=? OR stock_user_company_id=?)":""}) inter_company_total`;
  const metricValues:unknown[]=[
    ...companyValues,...companyValues,
    ...companyValues,...companyValues,current,...companyValues,
    ...companyValues,...companyValues,current,...companyValues,
    range.from,range.to,...companyValues,range.from,range.to,...companyValues,range.from,range.to,...companyValues,
    range.from,range.to,...companyValues,range.from,range.to,...companyValues,
    ...companyValues,...(user.activeCompanyId?[user.activeCompanyId,user.activeCompanyId]:[]),
  ];
  const results=await c.env.DB.batch([
    c.env.DB.prepare(metricSql).bind(...metricValues),
    c.env.DB.prepare(`SELECT month,SUM(sales_paise) sales_paise,SUM(purchases_paise) purchases_paise FROM (SELECT substr(invoice_date,1,7) month,SUM(grand_total_paise) sales_paise,0 purchases_paise FROM sales WHERE is_void=0 AND invoice_date BETWEEN ? AND ?${companyPredicate} GROUP BY substr(invoice_date,1,7) UNION ALL SELECT substr(bill_date,1,7),0,SUM(grand_total_paise) FROM purchases WHERE is_void=0 AND bill_date BETWEEN ? AND ?${companyPredicate} GROUP BY substr(bill_date,1,7)) trend GROUP BY month ORDER BY month DESC LIMIT 13`).bind(range.from,range.to,...companyValues,range.from,range.to,...companyValues),
    bind(`SELECT r.document_number,r.due_date,r.balance_amount_paise,c.code company,cu.name party FROM receivables r JOIN companies c ON c.id=r.company_id LEFT JOIN customers cu ON cu.id=r.customer_id WHERE r.balance_amount_paise>0 AND r.due_date<?${user.activeCompanyId?" AND r.company_id=?":""} ORDER BY r.due_date,r.id LIMIT 8`,current),
    bind(`SELECT p.document_number,p.due_date,p.balance_amount_paise,c.code company,s.name party FROM payables p JOIN companies c ON c.id=p.company_id LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.balance_amount_paise>0 AND p.due_date<?${user.activeCompanyId?" AND p.company_id=?":""} ORDER BY p.due_date,p.id LIMIT 8`,current),
    c.env.DB.prepare(`SELECT c.code company,sb.name stock_book,i.code item_code,i.name item,COALESCE(b.quantity_milliunits,0) quantity_milliunits,i.minimum_stock_milliunits FROM stock_books sb JOIN companies c ON c.id=sb.company_id CROSS JOIN items i LEFT JOIN inventory_balances b ON b.company_id=sb.company_id AND b.stock_book_id=sb.id AND b.item_id=i.id WHERE sb.active=1 AND i.active=1 AND COALESCE(b.quantity_milliunits,0)<=i.minimum_stock_milliunits${user.activeCompanyId?" AND sb.company_id=?":""} ORDER BY COALESCE(b.quantity_milliunits,0),i.code,sb.code LIMIT 8`).bind(...companyValues),
    user.activeCompanyId
      ? c.env.DB.prepare("SELECT oc.code owner,uc.code user,i.code item,l.quantity_milliunits,l.balance_amount_paise,l.due_date FROM inter_company_ledger_entries l JOIN companies oc ON oc.id=l.stock_owner_company_id JOIN companies uc ON uc.id=l.stock_user_company_id LEFT JOIN items i ON i.id=l.item_id WHERE l.status='PENDING' AND (l.stock_owner_company_id=? OR l.stock_user_company_id=?) ORDER BY l.due_date,l.id LIMIT 8").bind(user.activeCompanyId,user.activeCompanyId)
      : c.env.DB.prepare("SELECT oc.code owner,uc.code user,i.code item,l.quantity_milliunits,l.balance_amount_paise,l.due_date FROM inter_company_ledger_entries l JOIN companies oc ON oc.id=l.stock_owner_company_id JOIN companies uc ON uc.id=l.stock_user_company_id LEFT JOIN items i ON i.id=l.item_id WHERE l.status='PENDING' ORDER BY l.due_date,l.id LIMIT 8"),
    user.activeCompanyId
      ? c.env.DB.prepare("SELECT code,name FROM companies WHERE id=? AND active=1").bind(user.activeCompanyId)
      : c.env.DB.prepare("SELECT NULL code,'All Companies' name"),
  ]);
  const rows=(index:number)=>(results[index]?.results??[]) as Record<string,unknown>[];
  const company=rows(6)[0]??{name:"All Companies",code:""};
  const receivable=scalar(results,0,"receivable_total"),payable=scalar(results,0,"payable_total");
  const hero=`<section class="hero-panel"><div class="hero-brand"><span class="hero-logo company-hero-logo"><img src="${company.code==="AI"?"/static/img/aditya-logo.jpg":company.code==="FML"?"/static/img/firsttech-logo.jpg":"/static/img/fastockflow-icon.png"}" alt="${escapeHtml(company.name)}"></span><div><h2>${escapeHtml(company.name)}</h2><p>${company.code==="AI"?"Jewellery factory supplies stock control":company.code==="FML"?"Next generation technology stock control":"Combined FirstTech and Aditya control"}</p></div></div><a class="secondary-button" href="/dashboard">Refresh</a></section>`;
  const cards=`<form class="inline-filters" method="get"><label>From <input type="date" name="from" value="${escapeHtml(range.from)}"></label><label>To <input type="date" name="to" value="${escapeHtml(range.to)}"></label><button type="submit">Apply</button></form><section class="metric-grid"><article class="metric-card" data-animate-card><span>Inventory</span><h3>Current stock</h3><strong data-count-value>${qty(scalar(results,0,"inventory_quantity"))}</strong><small>₹${money(scalar(results,0,"inventory_value"))} FIFO value</small></article><article class="metric-card danger" data-animate-card><span>Customer</span><h3>Receivable balance</h3><strong>₹${money(receivable)}</strong><small>${scalar(results,0,"receivable_overdue")} due or overdue</small></article><article class="metric-card amber" data-animate-card><span>Supplier</span><h3>Payable balance</h3><strong>₹${money(payable)}</strong><small>Supplier and inter-company dues</small></article><article class="metric-card" data-animate-card><span>Inter-company</span><h3>Pending balance</h3><strong>₹${money(scalar(results,0,"inter_company_total"))}</strong><small>Open inter-company ledger</small></article><article class="metric-card danger" data-animate-card><span>Stock alerts</span><h3>Low / out items</h3><strong data-count-value>${scalar(results,0,"low_stock_count")}</strong><small>Evaluated by book and item</small></article></section>`;
  const trendRows=rows(1);
  const bars=trendRows.length?trendRows.map(row=>`<div class="dashboard-bar-row" data-bar-value="${Number(row.sales_paise??0)}"><span>${escapeHtml(row.month)}</span><div class="dashboard-bar-track"><i></i></div><strong>₹${money(row.sales_paise)}</strong></div>`).join(""):'<div class="empty chart-empty">No sales recorded this month.</div>';
  const analytics=`<section class="grid two analytics-grid"><div class="panel analytics-panel"><div class="panel-title"><h2>Sales Trend</h2><a href="/reports/sales-monthly">Monthly report</a></div><div class="dashboard-bars" data-auto-bars>${bars}</div></div><div class="panel analytics-panel"><div class="panel-title"><h2>Receivable vs Payable</h2><a href="/finance/outstanding">Outstanding</a></div><div class="split-chart" data-split-chart><div class="split-track"><span data-split-segment data-split-value="${receivable}" class="split-receivable"></span><span data-split-segment data-split-value="${payable}" class="split-payable"></span></div><div class="split-legend"><span><i class="split-receivable"></i>Receivable ₹${money(receivable)}</span><span><i class="split-payable"></i>Payable ₹${money(payable)}</span></div></div></div></section>`;
  const monthSales=`<section class="grid two"><div class="panel"><div class="panel-title"><h2>Month Sales</h2><a href="/reports/sales-by-type">View report</a></div>${dashboardTable(["Month","Sales","Purchases"],trendRows.map(row=>[escapeHtml(row.month),`₹${money(row.sales_paise)}`,`₹${money(row.purchases_paise)}`]),"No sales recorded this month.")}</div><div class="panel"><div class="panel-title"><h2>Stock Alerts</h2><a href="/reports/stock-alerts">View report</a></div>${dashboardTable(["Book","Item","Qty"],rows(4).map(row=>[escapeHtml(`${row.company} · ${row.stock_book}`),escapeHtml(`${row.item_code} - ${row.item}`),qty(row.quantity_milliunits)]),"No stock alerts.")}</div></section>`;
  const overdue=`<section class="grid two"><div class="panel"><div class="panel-title"><h2>Overdue Receivables</h2><a href="/finance/outstanding">Outstanding</a></div>${dashboardTable(["Company","Customer","Document","Balance"],rows(2).map(row=>[escapeHtml(row.company),escapeHtml(row.party),escapeHtml(row.document_number),`₹${money(row.balance_amount_paise)}`]),"No overdue receivables.")}</div><div class="panel"><div class="panel-title"><h2>Overdue Payables</h2><a href="/finance/outstanding">Outstanding</a></div>${dashboardTable(["Company","Supplier","Document","Balance"],rows(3).map(row=>[escapeHtml(row.company),escapeHtml(row.party),escapeHtml(row.document_number),`₹${money(row.balance_amount_paise)}`]),"No overdue payables.")}</div></section>`;
  const interCompany=`<section class="panel"><div class="panel-title"><h2>Pending Inter-company</h2><a href="/reports/inter-company">View report</a></div>${dashboardTable(["Owner","User","Item","Quantity","Balance","Due"],rows(5).map(row=>[escapeHtml(row.owner),escapeHtml(row.user),escapeHtml(row.item),qty(row.quantity_milliunits),`₹${money(row.balance_amount_paise)}`,escapeHtml(row.due_date)]),"No pending inter-company entries.")}</section>`;
  return c.html(layout("Dashboard",hero+cards+analytics+monthSales+overdue+interCompany,user,{subtitle:"Stock, outstanding, alerts, and inter-company control at a glance.",company:{name:String(company.name),code:String(company.code??"")},dueAlertCount:scalar(results,0,"receivable_overdue")+scalar(results,0,"payable_overdue")}));
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
