import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { layout, money, qty, table } from "../views/html";

const dashboard = new Hono<{ Bindings: Env; Variables: AppVariables }>();

dashboard.get("/", async (c) => {
  const user = c.get("user")!;
  const companyId = user.activeCompanyId;
  const companyPredicate = companyId ? " AND company_id=?" : "";
  const bind = <T>(sql: string): D1PreparedStatement => companyId ? c.env.DB.prepare(sql).bind(companyId) : c.env.DB.prepare(sql);
  const results = await c.env.DB.batch([
    bind(`SELECT COALESCE(SUM(quantity_milliunits),0) quantity FROM inventory_balances WHERE 1=1${companyPredicate}`),
    bind(`SELECT COALESCE(SUM(balance_amount_paise),0) total,COUNT(*) count FROM receivables WHERE balance_amount_paise>0${companyPredicate}`),
    bind(`SELECT COALESCE(SUM(balance_amount_paise),0) total,COUNT(*) count FROM payables WHERE balance_amount_paise>0${companyPredicate}`),
    bind(`SELECT COUNT(*) count FROM sales WHERE is_void=0${companyPredicate}`),
    bind(`SELECT COUNT(*) count FROM purchases WHERE is_void=0${companyPredicate}`),
  ]);
  const scalar = (index: number, key: string): number => Number((results[index]?.results?.[0] as Record<string, unknown> | undefined)?.[key] ?? 0);
  const cards = `<section class="metric-grid"><article class="metric-card"><span>Inventory</span><h3>Current stock</h3><strong>${qty(scalar(0, "quantity"))}</strong><small>Available quantity across active books</small></article><article class="metric-card danger"><span>Customer</span><h3>Receivables</h3><strong>₹${money(scalar(1, "total"))}</strong><small>${scalar(1, "count")} open balances</small></article><article class="metric-card amber"><span>Supplier</span><h3>Payables</h3><strong>₹${money(scalar(2, "total"))}</strong><small>${scalar(2, "count")} open balances</small></article><article class="metric-card"><span>Billing</span><h3>Sales</h3><strong>${scalar(3, "count")}</strong><small>Active sales documents</small></article><article class="metric-card"><span>Stock intake</span><h3>Purchases</h3><strong>${scalar(4, "count")}</strong><small>Active purchase documents</small></article></section>`;
  return c.html(layout("Dashboard", cards, user));
});

dashboard.get("/calendar-events", async (c) => {
  const user = c.get("user")!;
  const start = c.req.query("start") ?? "0000-01-01";
  const end = c.req.query("end") ?? "9999-12-31";
  const scope = user.activeCompanyId ? " AND company_id=?" : "";
  const params = user.activeCompanyId ? [start, end, user.activeCompanyId] : [start, end];
  const queries = [
    [`SELECT id,invoice_date date,invoice_number title,'sale' type FROM sales WHERE is_void=0 AND invoice_date BETWEEN ? AND ?${scope} LIMIT 200`, "/transactions/sale/"],
    [`SELECT id,bill_date date,bill_number title,'purchase' type FROM purchases WHERE is_void=0 AND bill_date BETWEEN ? AND ?${scope} LIMIT 200`, "/transactions/purchase/"],
  ] as const;
  const result = await c.env.DB.batch(queries.map(([sql]) => c.env.DB.prepare(sql).bind(...params)));
  return c.json(result.flatMap((entry, index) => (entry.results ?? []).map((row) => ({ ...row as object, url: `${queries[index]?.[1] ?? "/"}${(row as Record<string, unknown>).id}/edit` }))));
});

export default dashboard;
