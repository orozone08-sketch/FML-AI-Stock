/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env as workerEnv } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import customers from "../../src/routes/customers";
import { permissionsFor } from "../../src/security/permissions";
import type { AppVariables, AuthUser, Env } from "../../src/types";

declare global {
  namespace Cloudflare { interface Env { DB: D1Database } }
}

const migrations = import.meta.glob("../../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

async function migratedDatabase(): Promise<D1Database> {
  const db = workerEnv.DB;
  for (const sourceRaw of Object.entries(migrations).sort(([left], [right]) => left.localeCompare(right)).map(([, source]) => source)) {
    for (const statement of sourceRaw.replaceAll("\r", "").split(";").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  const now = "2026-07-15T00:00:00.000Z";
  await db.batch([
    db.prepare("INSERT INTO companies(id,name,code,active,created_at,updated_at) VALUES(1,'Firsttech','FML',1,?,?)").bind(now, now),
    db.prepare("INSERT INTO stock_books(id,company_id,name,code,book_type,active,created_at,updated_at) VALUES(1,1,'GST','FML-GST','GST',1,?,?)").bind(now, now),
    db.prepare("INSERT INTO items(id,code,name,unit,active,created_at,updated_at) VALUES(1,'ITM','Tool','pcs',1,?,?)").bind(now, now),
    db.prepare("INSERT INTO customers(id,code,name,customer_type,mobile,active,created_at,updated_at) VALUES(1,'CUS','Buyer','BILL','999',1,?,?)").bind(now, now),
    db.prepare("INSERT INTO sales(id,company_id,stock_book_id,customer_id,sale_type,invoice_number,invoice_date,subtotal_paise,gst_total_paise,grand_total_paise,fifo_cost_paise,gross_profit_paise,paid_amount_paise,balance_amount_paise,payment_status,created_at,updated_at) VALUES(1,1,1,1,'GST','INV-1','2026-07-01',10000,1800,11800,5000,6800,0,11800,'UNPAID',?,?)").bind(now, now),
    db.prepare("INSERT INTO sale_lines(id,sale_id,item_id,quantity_milliunits,sale_rate_ten_thousandths,gst_basis_points,subtotal_paise,gst_amount_paise,line_total_paise,fifo_cost_paise,gross_profit_paise) VALUES(1,1,1,1000,1000000,1800,10000,1800,11800,5000,6800)"),
    db.prepare("INSERT INTO receivables(id,company_id,stock_book_id,customer_id,source_type,source_id,document_number,document_date,total_amount_paise,paid_amount_paise,balance_amount_paise,payment_status,created_at,updated_at) VALUES(1,1,1,1,'SALE',1,'INV-1','2026-07-01',11800,0,11800,'UNPAID',?,?)").bind(now, now),
  ]);
  return db;
}

function app(db: D1Database) {
  const authUser: AuthUser = { id: 1, name: "Admin", email: "admin@example.test", role: "ADMIN", companyId: 1,
    activeCompanyId: 1, forcePasswordChange: false, permissions: permissionsFor("ADMIN"), csrfToken: "csrf", sessionId: 1 };
  const hono = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  hono.use("*", async (c, next) => { c.set("user", authUser); c.set("requestId", "request"); await next(); });
  hono.route("/customers", customers);
  return { hono, bindings: { DB: db } as Env };
}

describe("customer JSON SQL against migrated D1", () => {
  it("executes the list/profile CTEs and uses the deployed profile indexes", async () => {
    const db = await migratedDatabase();
    const { hono, bindings } = app(db);
    const list = await hono.request("https://example.test/customers?q=buyer", {}, bindings);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ customers: [{ customer_name: "Buyer", companies: [{ code: "FML" }] }] });
    const detail = await hono.request("https://example.test/customers/1?date_from=2026-04-01&date_to=2026-07-15", {}, bindings);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ summary: { total_invoices: 1, total_pending: "₹118.00" }, challans: [{ item_name: "ITM - Tool (pcs)" }] });

    const plans = await db.batch([
      db.prepare("EXPLAIN QUERY PLAN SELECT id FROM sales WHERE customer_id=1 AND is_void=0 AND invoice_date>='2026-04-01' ORDER BY invoice_date DESC,id DESC"),
      db.prepare("EXPLAIN QUERY PLAN SELECT id FROM receivables WHERE customer_id=1 AND company_id=1 AND document_date>='2026-04-01'"),
      db.prepare("EXPLAIN QUERY PLAN SELECT id FROM payments WHERE customer_id=1 AND payment_date>='2026-04-01' ORDER BY payment_date DESC,id DESC"),
      db.prepare("EXPLAIN QUERY PLAN SELECT id FROM sale_lines WHERE sale_id=1 ORDER BY id"),
      db.prepare("EXPLAIN QUERY PLAN SELECT id FROM purchases WHERE supplier_id=1 AND is_void=0 ORDER BY bill_date DESC,id DESC"),
      db.prepare("EXPLAIN QUERY PLAN SELECT id FROM payables WHERE supplier_id=1 AND company_id=1"),
      db.prepare("EXPLAIN QUERY PLAN SELECT id FROM payments WHERE supplier_id=1 ORDER BY payment_date DESC,id DESC"),
      db.prepare("EXPLAIN QUERY PLAN SELECT id FROM opening_stock_lines WHERE opening_stock_id=1 ORDER BY id"),
      db.prepare("EXPLAIN QUERY PLAN SELECT id FROM purchase_lines WHERE purchase_id=1 ORDER BY id"),
      db.prepare("EXPLAIN QUERY PLAN SELECT id FROM transfer_lines WHERE transfer_id=1 ORDER BY id"),
    ]);
    const details = plans.map((plan) => plan.results.map((row) => String((row as Record<string, unknown>).detail)).join("\n"));
    expect(details[0]).toContain("idx_sales_customer_profile");
    expect(details[1]).toContain("idx_receivables_customer_profile");
    expect(details[2]).toContain("idx_payments_customer_profile");
    expect(details[3]).toContain("idx_sale_lines_sale");
    expect(details[4]).toContain("idx_purchases_supplier_profile");
    expect(details[5]).toContain("idx_payables_supplier_profile");
    expect(details[6]).toContain("idx_payments_supplier_profile");
    expect(details[7]).toContain("idx_opening_stock_lines_opening");
    expect(details[8]).toContain("idx_purchase_lines_purchase");
    expect(details[9]).toContain("idx_transfer_lines_transfer");
    expect(details.join("\n")).not.toContain("SCAN ");
  });
});
