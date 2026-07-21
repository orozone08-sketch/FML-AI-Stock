import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/app";
import { sha256 } from "../../src/security/crypto";
import type { Env, Role } from "../../src/types";

type Row = Record<string, unknown>;

class Statement {
  params: unknown[] = [];
  constructor(readonly query: string, private readonly db: RouteDb) {}
  bind(...params: unknown[]) { this.params = params; return this; }
  first<T>() { return Promise.resolve(this.db.first(this.query, this.params) as T); }
  all<T>() { return Promise.resolve({ results: this.db.all(this.query, this.params) } as T); }
  run<T>() { this.db.writes.push(this); return Promise.resolve({ success: true, meta: { last_row_id: 1 } } as T); }
}

class RouteDb {
  role: Role = "VIEWER";
  companyId: number | null = 1;
  csrfDigest = "";
  statements: Statement[] = [];
  writes: Statement[] = [];

  prepare(query: string) { const statement = new Statement(query, this); this.statements.push(statement); return statement; }
  first(query: string, _params: unknown[]): Row | null {
    if (query.includes("FROM sessions s JOIN users u")) return {
      session_id: 91, csrf_digest: this.csrfDigest, id: 7, name: "Route Tester",
      email: "route@example.test", role: this.role, company_id: this.companyId,
      force_password_change: 0,
    };
    return null;
  }
  all(query: string, _params: unknown[]): Row[] {
    if (query.includes("FROM permission_overrides")) return [];
    return [];
  }
  batch<T>(statements: Statement[]) {
    const results = statements.map((statement) => {
      if (statement.query.includes("SUM(quantity_milliunits)")) return { results: [{ quantity: -2_000, value: 25_000 }] };
      if (statement.query.includes("FROM receivables")) return { results: [{ total: 12_500, count: 1, overdue: 1 }] };
      if (statement.query.includes("FROM payables")) return { results: [{ total: 5_000, count: 1, overdue: 0 }] };
      if (statement.query.includes("FROM sales WHERE")) return { results: [{ count: 3, total: 30_000, profit: 7_000 }] };
      if (statement.query.includes("FROM purchases WHERE")) return { results: [{ count: 2, total: 20_000 }] };
      if (statement.query.includes("JOIN items i") && statement.query.includes("minimum_stock")) return { results: [{ count: 4 }] };
      if (statement.query.includes("FROM inter_company_ledger_entries")) return { results: [{ total: 9_000 }] };
      if (statement.query.startsWith("SELECT id,code,name,contact_person")) return { results: [{ id: 10, code: "C-10", name: "Scoped Customer" }] };
      return { results: this.all(statement.query, statement.params) };
    });
    return Promise.resolve(results as T);
  }
}

function environment(db: RouteDb): Env {
  return {
    DB: db as unknown as D1Database,
    FILES: {} as R2Bucket,
    ACCOUNTING: {} as DurableObjectNamespace,
    ASSETS: {} as Fetcher,
    APP_ENV: "test",
    SITE_URL: "https://example.test",
    SESSION_HMAC_KEY: "session-secret",
    CSRF_HMAC_KEY: "csrf-secret",
  };
}

const authenticated = (path: string, init: RequestInit = {}) => app.request(`https://example.test${path}`, {
  ...init,
  headers: { Cookie: "fastock_session=session-token; fastock_csrf=csrf-token", ...(init.headers ?? {}) },
}, currentEnv);

let db: RouteDb;
let currentEnv: Env;

beforeEach(async () => {
  db = new RouteDb();
  db.csrfDigest = await sha256("csrf-token");
  currentEnv = environment(db);
});

describe("authenticated route integration", () => {
  it("allows username-style IDs on the owner/admin login form", async () => {
    const response = await app.request("https://example.test/admin/login", {}, currentEnv);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('type="text" name="email"');
    expect(html).toContain('autocomplete="username"');
    expect(html).not.toContain('type="email" name="email"');
  });

  it("redirects unauthenticated HTML requests without touching business tables", async () => {
    const response = await app.request("https://example.test/dashboard", {}, currentEnv);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login?next=%2Fdashboard");
    expect(db.statements).toHaveLength(0);
  });

  it("renders a company-scoped dashboard and binds the assigned company to every KPI", async () => {
    const response = await authenticated("/dashboard");
    expect(response.status).toBe(200);
    const html=await response.text();
    expect(html).toContain("<strong>-2</strong>");
    const kpis = db.statements.filter((statement) => /inventory_balances|receivables|payables|FROM sales WHERE|FROM purchases WHERE|inter_company_ledger_entries/.test(statement.query));
    // Seven headline metrics plus period trend and four bounded critical-detail
    // queries (receivables, payables, low stock, inter-company).
    expect(kpis).toHaveLength(12);
    expect(kpis.every((statement) => statement.params.includes(1))).toBe(true);
    expect(html).toContain("ledger value");
    expect(html).toContain("Period trend");
    expect(html).toContain("Critical customer dues");
    expect(html).toContain("data-floating-tools");
    expect(html).toContain('data-calendar-url="/dashboard/calendar-events"');
  });

  it("rejects invalid dashboard and calendar ranges before business queries",async()=>{
    expect((await authenticated("/dashboard?from=2026-02-30")).status).toBe(400);
    expect((await authenticated("/dashboard/calendar-events?start=bad&end=2026-07-01")).status).toBe(400);
  });

  it("serves real report export formats with their declared content types",async()=>{
    db.role="ADMIN";
    const xlsx=await authenticated("/reports/sales?format=xlsx");
    expect(xlsx.status).toBe(200);expect(xlsx.headers.get("content-type")).toContain("spreadsheetml");
    expect(Array.from(new Uint8Array(await xlsx.arrayBuffer()).slice(0,4))).toEqual([0x50,0x4b,0x03,0x04]);
    const pdf=await authenticated("/reports/sales?format=pdf");
    expect(pdf.status).toBe(200);expect(pdf.headers.get("content-type")).toContain("application/pdf");
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0,8))).toBe("%PDF-1.4");
  });

  it("scopes stock-book HTML and denies create UI when the role has view-only access", async () => {
    const list = await authenticated("/masters/stock-books");
    expect(list.status).toBe(200);
    const query = db.statements.find((statement) => statement.query.includes("FROM stock_books") && statement.query.includes("ORDER BY code"));
    expect(query?.query).toContain("company_id=?");
    expect(query?.params).toEqual([1]);
    expect(await list.text()).not.toContain("New Stock-book");

    const create = await authenticated("/masters/items/new");
    expect(create.status).toBe(403);
    expect(await create.text()).toBe("Forbidden");
  });

  it("ignores a customer company selector when the login is fixed to an active company", async () => {
    const response = await authenticated("/customers/10?company_id=2");
    expect(response.status).toBe(200);
    const query = db.statements.find((statement) => statement.query.includes("FROM receivables r WHERE r.customer_id"));
    expect(query?.params.slice(0, 2)).toEqual([10, 1]);
  });

  it("binds customer stock JSON to both the requested customer and active company", async () => {
    const response = await authenticated("/customers/10/stock");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      summary: { stock_given: "0", stock_received_back: "0", pending_stock: "0" },
      stock: [],
    });
    const query = db.statements.find((statement) => statement.query.includes("FROM sale_lines sl"));
    expect(query?.query).toContain("s.company_id=?");
    expect(query?.params.slice(0, 2)).toEqual([10, 1]);
  });

  it("blocks state-changing routes at CSRF middleware before permission or D1 writes", async () => {
    db.role = "ADMIN";
    const response = await authenticated("/masters/items/new", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "csrf_token=wrong&code=X&name=Wrong",
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Invalid CSRF token");
    expect(db.writes).toHaveLength(0);
    expect(db.statements.some((statement) => statement.query.startsWith("INSERT"))).toBe(false);
  });
});
