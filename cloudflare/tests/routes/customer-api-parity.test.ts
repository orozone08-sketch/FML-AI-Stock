import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import customers from "../../src/routes/customers";
import { permissionsFor } from "../../src/security/permissions";
import type { AppVariables, AuthUser, Env } from "../../src/types";

type Row = Record<string, unknown>;

class Statement {
  params: unknown[] = [];
  constructor(readonly query: string, private readonly db: CustomerDb) {}
  bind(...params: unknown[]) { this.params = params; return this; }
  all<T>() { return Promise.resolve({ results: this.db.rows(this) } as T); }
}

class CustomerDb {
  statements: Statement[] = [];
  batches = 0;
  batchSizes: number[] = [];
  prepare(query: string) { const statement = new Statement(query, this); this.statements.push(statement); return statement; }
  batch<T>(statements: Statement[]) {
    this.batches += 1;
    this.batchSizes.push(statements.length);
    return Promise.resolve(statements.map((statement) => ({ results: this.rows(statement) })) as T);
  }
  rows(statement: Statement): Row[] {
    const sql = statement.query;
    if (sql.includes("WITH linked(customer_id,company_id)")) return [
      { id: 10, code: "CU-10", name: "Profile Customer", contact_person: "Amarjit Contact", mobile: "9999999999", whatsapp: "8888888888", email: "profile@example.com", gst_number: "GSTPROFILE1", address: "Profile address", city: "Mumbai", state: "Maharashtra", notes: "Important profile note", active: 1, created_at: "2026-01-01T10:00:00.000Z", updated_at: "2026-06-25T11:00:00.000Z", linked_company_id: 1, linked_company_code: "AI", linked_company_name: "AI Company" },
    ];
    if (sql.startsWith("SELECT id,code,name,contact_person")) return [
      { id: 10, code: "CU-10", name: "Profile Customer", contact_person: "Amarjit Contact", mobile: "9999999999", whatsapp: "8888888888", email: "profile@example.com", gst_number: "GSTPROFILE1", address: "Profile address", city: "Mumbai", state: "Maharashtra", notes: "Important profile note", active: 1, created_at: "2026-01-01T10:00:00.000Z", updated_at: "2026-06-25T11:00:00.000Z" },
    ];
    if (sql.includes("SELECT co.id,co.code,co.name FROM companies")) return [{ id: 1, code: "AI", name: "AI Company" }];
    if (sql.includes("FROM sales s JOIN companies")) return [{ id: 41, company_id: 1, company: "AI", invoice_number: "PROFILE-INV-1", invoice_date: "2026-06-25", due_date: "2026-06-30", sale_type: "GST", grand_total_paise: 23_600, paid_amount_paise: 11_800, balance_amount_paise: 11_800, payment_status: "PARTIAL" }];
    if (sql.includes("FROM receivables r WHERE")) return [{ balance_paise: 11_800, last_transaction: "2026-06-25" }];
    if (sql.includes("FROM payments p JOIN companies")) return [{ id: 51, company_id: 1, company: "AI", payment_date: "2026-06-25", mode: "BANK", total_amount_paise: 11_800, allocated_amount_paise: 11_800, unallocated_amount_paise: 0, reference_number: "PROFILE-RCPT-1", remarks: "Received" }];
    if (sql.includes("FROM sale_lines sl JOIN sales")) return [{ id: 61, sale_id: 41, challan_number: "PROFILE-INV-1", challan_date: "2026-06-25", payment_status: "PARTIAL", item_code: "IT-1", item_name: "Gold", unit: "gm", quantity_milliunits: 2_000 }];
    return [];
  }
}

function user(activeCompanyId: number | null): AuthUser {
  return { id: 7, name: "Tester", email: "test@example.com", role: "ADMIN", companyId: activeCompanyId,
    activeCompanyId, forcePasswordChange: false, permissions: permissionsFor("ADMIN"), csrfToken: "csrf", sessionId: 9 };
}

function env(db: CustomerDb): Env {
  return { DB: db as unknown as D1Database, FILES: {} as R2Bucket, ACCOUNTING: {} as DurableObjectNamespace,
    ASSETS: {} as Fetcher, APP_ENV: "test", SITE_URL: "https://example.test", SESSION_HMAC_KEY: "session", CSRF_HMAC_KEY: "csrf" };
}

function application(authUser: AuthUser) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => { c.set("user", authUser); c.set("requestId", "request"); await next(); });
  app.route("/customers", customers);
  return app;
}

describe("legacy customer JSON API parity", () => {
  it("matches the list route shape, search fields, company scope, and timestamp/boolean formatting", async () => {
    const db = new CustomerDb();
    const response = await application(user(1)).request("https://example.test/customers?q=gstprofile1&active=all&company_id=2", {}, env(db));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ customers: [{
      id: 10, code: "CU-10", customer_name: "Profile Customer", contact_person: "Amarjit Contact",
      mobile: "9999999999", whatsapp: "8888888888", email: "profile@example.com", gst_number: "GSTPROFILE1",
      address: "Profile address", city: "Mumbai", state: "Maharashtra", notes: "Important profile note", active: true,
      created_at: "2026-01-01T10:00:00", updated_at: "2026-06-25T11:00:00",
      companies: [{ id: 1, code: "AI", name: "AI Company" }], display: "CU-10 - Profile Customer · 9999999999",
    }] });
    const query = db.statements[0]!;
    expect(query.query).not.toContain("c.active=1");
    expect(query.params[0]).toBe(1);
    expect(query.params[1]).toBe(1);
    expect(query.params.slice(2)).toEqual(Array(13).fill("%gstprofile1%"));
  });

  it("matches detail plus all four child route wrappers and uses a constant six-query profile batch", async () => {
    const db = new CustomerDb();
    const app = application(user(1));
    const suffix = "?date_from=2026-06-30&date_to=2026-06-01&company_id=2";
    const detail = await app.request(`https://example.test/customers/10${suffix}`, {}, env(db));
    expect(detail.status).toBe(200);
    const payload = await detail.json() as any;
    expect(payload).toEqual({
      customer: { id: 10, code: "CU-10", customer_name: "Profile Customer", contact_person: "Amarjit Contact", mobile: "9999999999", whatsapp: "8888888888", email: "profile@example.com", gst_number: "GSTPROFILE1", address: "Profile address", city: "Mumbai", state: "Maharashtra", notes: "Important profile note", active: true, created_at: "2026-01-01T10:00:00", updated_at: "2026-06-25T11:00:00" },
      companies: [{ id: 1, code: "AI", name: "AI Company" }],
      summary: { total_invoices: 1, total_sales: "₹236.00", total_received: "₹118.00", total_pending: "₹118.00", last_transaction_date: "2026-06-25", last_payment_date: "2026-06-25", stock_given: "2", stock_received_back: "0", pending_stock: "2" },
      invoices: [{ id: 41, company_id: 1, company: "AI", invoice_number: "PROFILE-INV-1", invoice_date: "2026-06-25", due_date: "2026-06-30", sale_type: "GST", total: "₹236.00", paid: "₹118.00", pending: "₹118.00", status: "PARTIAL", edit_url: "/transactions/sale/41/edit", pdf_url: "/transactions/sale/41/export/pdf" }],
      challans: [{ challan_number: "PROFILE-INV-1", challan_date: "2026-06-25", item_name: "IT-1 - Gold (gm)", quantity: "2", weight: "2.000 gm", status: "Pending", pdf_url: "/transactions/sale/41/export/pdf" }],
      stock: { summary: { stock_given: "2", stock_received_back: "0", pending_stock: "2" }, rows: [{ challan_number: "PROFILE-INV-1", challan_date: "2026-06-25", item_name: "IT-1 - Gold (gm)", quantity: "2", weight: "2.000 gm", status: "Pending", pdf_url: "/transactions/sale/41/export/pdf" }] },
      payments: [{ id: 51, company_id: 1, company: "AI", payment_date: "2026-06-25", payment_mode: "BANK", amount: "₹118.00", allocated: "₹118.00", pending: "₹0.00", reference_number: "PROFILE-RCPT-1", remarks: "Received" }],
      documents: [{ label: "Invoice PDF - PROFILE-INV-1", type: "Invoice PDF", date: "2026-06-25", sale_id: 41, url: "/transactions/sale/41/export/pdf" }],
    });

    const invoices = await app.request(`https://example.test/customers/10/invoices${suffix}`, {}, env(db));
    const challans = await app.request(`https://example.test/customers/10/challans${suffix}`, {}, env(db));
    const payments = await app.request(`https://example.test/customers/10/payments${suffix}`, {}, env(db));
    const stock = await app.request(`https://example.test/customers/10/stock${suffix}`, {}, env(db));
    expect(await invoices.json()).toEqual({ invoices: payload.invoices });
    expect(await challans.json()).toEqual({ challans: payload.challans });
    expect(await payments.json()).toEqual({ payments: payload.payments });
    expect(await stock.json()).toEqual({ summary: payload.stock.summary, stock: payload.stock.rows });
    expect(db.batches).toBe(5);
    expect(db.batchSizes).toEqual([6, 2, 2, 2, 2]);
    for (const statement of db.statements.filter((item) => /FROM sales s JOIN companies|FROM receivables r WHERE|FROM payments p JOIN companies|FROM sale_lines sl JOIN sales/.test(item.query))) {
      expect(statement.params).toEqual([10, 1, "2026-06-01", "2026-06-30"]);
    }
  });

  it("allows an all-company admin to select a company while an assigned user always stays in their fixed scope", async () => {
    const allDb = new CustomerDb();
    await application(user(null)).request("https://example.test/customers/10?company_id=2&date_from=2026-06-01&date_to=2026-06-30", {}, env(allDb));
    expect(allDb.statements.find((item) => item.query.includes("FROM sales s JOIN companies"))?.params).toEqual([10, 2, "2026-06-01", "2026-06-30"]);
    const fixedDb = new CustomerDb();
    await application(user(1)).request("https://example.test/customers/10?company_id=2&date_from=2026-06-01&date_to=2026-06-30", {}, env(fixedDb));
    expect(fixedDb.statements.find((item) => item.query.includes("FROM sales s JOIN companies"))?.params).toEqual([10, 1, "2026-06-01", "2026-06-30"]);
  });
});
