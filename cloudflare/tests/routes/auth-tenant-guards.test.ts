import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/app";
import { companyCookie } from "../../src/auth/session";
import { sha256 } from "../../src/security/crypto";
import type { Env, Role } from "../../src/types";

type Row = Record<string, unknown>;

class Statement {
  params: unknown[] = [];
  constructor(readonly query: string, private readonly db: GuardDb) {}
  bind(...params: unknown[]) { this.params = params; return this; }
  first<T>() { return Promise.resolve(this.db.first(this.query, this.params) as T); }
  all<T>() { return Promise.resolve({ results: this.db.all(this.query, this.params) } as T); }
  run<T>() { this.db.writes.push(this); return Promise.resolve({ success: true, meta: { last_row_id: 12 } } as T); }
}

class GuardDb {
  role: Role = "ADMIN";
  companyId: number | null = 1;
  forcePasswordChange = false;
  csrfDigest = "";
  statements: Statement[] = [];
  writes: Statement[] = [];
  overrides: Row[] = [];

  prepare(query: string) { const statement = new Statement(query, this); this.statements.push(statement); return statement; }
  first(query: string, params: unknown[]): Row | null {
    if (query.includes("FROM sessions s JOIN users u")) return {
      session_id: 91, csrf_digest: this.csrfDigest, id: 7, name: "Guard Tester",
      email: "guard@example.test", role: this.role, company_id: this.companyId,
      force_password_change: this.forcePasswordChange ? 1 : 0,
      active_company_id: this.companyId ?? (this.role === "ADMIN" && Number(params[0]) === 1 ? 1 : null),
      permission_overrides_json: JSON.stringify(this.overrides),
    };
    if (query.startsWith("SELECT id FROM companies WHERE id=? AND active=1")) return Number(params[0]) === 1 ? { id: 1 } : null;
    if (query.includes("FROM payments WHERE id=?")) return Number(params[0]) === 10 && (!query.includes("company_id=?") || Number(params[1]) === 1)
      ? { id: 10, company_id: 1, payment_type: "CUSTOMER_RECEIPT", customer_id: 3, payment_date: "2026-07-15", mode: "BANK", total_amount_paise: 1000 }
      : null;
    if (query.startsWith("SELECT * FROM purchases WHERE id=?")) return Number(params[0]) === 10 && Number(params[1]) === 1
      ? { id: 10, company_id: 1, supplier_id: 2, stock_book_id: 3, bill_number: "P-10", bill_date: "2026-07-15", due_date: "2026-08-15", purchase_type: "CASH" }
      : null;
    if (query.startsWith("SELECT * FROM receivables WHERE id=?")) return Number(params[0]) === 10 && Number(params[1]) === 1 && query.includes("is_opening=1")
      ? { id: 10, company_id: 1, customer_id: 2, is_opening: 1, document_number: "OR-10", document_date: "2026-07-15", total_amount_paise: 1000 }
      : null;
    if (query.startsWith("SELECT * FROM stock_books WHERE id=?")) return Number(params[0]) === 10 && Number(params[1]) === 1
      ? { id: 10, company_id: 1, code: "SB", name: "Book", book_type: "GST", active: 1 }
      : null;
    if (query.startsWith("SELECT * FROM users WHERE id=?")) return Number(params[0]) === 7 && (!query.includes("company_id=?") || Number(params[1]) === 1)
      ? { id: 7, company_id: 1, name: "Guard Tester", email: "guard@example.test", role: "VIEWER", active: 1, force_password_change: 0 }
      : null;
    if (query.startsWith("SELECT role,active,company_id FROM users WHERE id=?")) return Number(params[0]) === 7 && Number(params[1]) === 1
      ? { role: "VIEWER", active: 1, company_id: 1 }
      : null;
    if (query.includes("COUNT(*) count FROM users")) return { count: 1 };
    return null;
  }
  all(query: string, params: unknown[]): Row[] {
    if (query.includes("FROM permission_overrides")) return this.overrides;
    if (query.includes("FROM payment_allocations WHERE payment_id")) return [{ target_id: 30 }];
    if (query.includes("FROM receivables") && query.includes("JOIN companies")) return [{ id: 30, document_number: "R-30", balance_amount_paise: 0, company_code: "C1" }];
    if (query.includes("FROM payments p JOIN companies")) return [{ id: 10, payment_date: "2026-07-15", payment_type: "CUSTOMER_RECEIPT", party: "Customer Three", company: "C1", mode: "BANK", reference_number: "PAY-REFERENCE-10", total_amount_paise: 1000, allocated_amount_paise: 1000, unallocated_amount_paise: 0 }];
    if (query.includes("FROM customers") && query.includes("active=1")) return [{ id: 3, code: "CU3", name: "Customer Three" }];
    if (query.includes("FROM companies WHERE active=1")) return !query.includes("id=?") || Number(params[0]) === 1 ? [{ id: 1, code: "C1", name: "Company One" }] : [];
    return [];
  }
  batch<T>(statements: Statement[]) {
    for (const statement of statements) if (!statement.query.trimStart().startsWith("SELECT")) this.writes.push(statement);
    return Promise.resolve(statements.map((statement) => ({ results: this.all(statement.query, statement.params), success: true })) as T);
  }
}

function environment(db: GuardDb): Env {
  return {
    DB: db as unknown as D1Database, FILES: {} as R2Bucket, ACCOUNTING: {} as DurableObjectNamespace,
    ASSETS: {} as Fetcher, APP_ENV: "test", SITE_URL: "https://example.test",
    SESSION_HMAC_KEY: "session-secret", CSRF_HMAC_KEY: "csrf-secret",
  };
}

const request = (path: string, init: RequestInit = {}) => app.request(`https://example.test${path}`, {
  ...init, headers: { Cookie: "fastock_session=session-token; fastock_csrf=csrf-token", ...(init.headers ?? {}) },
}, env);

let db: GuardDb;
let env: Env;

beforeEach(async () => {
  db = new GuardDb(); db.csrfDigest = await sha256("csrf-token"); env = environment(db);
});

describe("forced password change enforcement", () => {
  it("redirects an existing forced session away from protected application routes", async () => {
    db.forcePasswordChange = true;
    const response = await request("/dashboard");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/change-password");
  });

  it("updates the password, clears the force flag, revokes other sessions, and audits the change", async () => {
    db.forcePasswordChange = true;
    const response = await request("/change-password", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "csrf_token=csrf-token&password=new-password-123&confirm_password=new-password-123",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/dashboard/");
    const sql = db.writes.map((statement) => statement.query).join("\n");
    expect(sql).toContain("force_password_change=0");
    expect(sql).toContain("UPDATE sessions SET revoked_at");
    expect(sql).toContain("'change_password'");
  });
});

describe("public authentication CSRF", () => {
  it("preserves safe post-login destinations without allowing external redirects", async () => {
    const protectedRoute = await app.request("https://example.test/reports/current-stock?format=csv", {}, env);
    expect(protectedRoute.headers.get("location")).toBe("/login?next=%2Freports%2Fcurrent-stock%3Fformat%3Dcsv");

    const safe = await app.request("https://example.test/login?next=%2Freports%2Fcurrent-stock", {}, env);
    const safeHtml = await safe.text();
    expect(safeHtml).toContain("/login/company/1?next=%2Freports%2Fcurrent-stock");

    const selected = await app.request("https://example.test/login/company/1?next=%2Freports%2Fcurrent-stock", {}, env);
    expect(await selected.text()).toContain('action="/login?next=%2Freports%2Fcurrent-stock"');

    const external = await app.request("https://example.test/login?next=https%3A%2F%2Fevil.example", {}, env);
    expect(await external.text()).not.toContain("evil.example");
  });

  it("requires a signed double-submit token for login and registration", async () => {
    const form = await app.request("https://example.test/login/company/1", {}, env);
    expect(form.status).toBe(200);
    const cookie = form.headers.get("set-cookie")!;
    const token = (await form.text()).match(/name="csrf_token" value="([^"]+)"/)?.[1];
    expect(token).toBeTruthy();
    expect(cookie).toContain("fastock_public_csrf=");

    const missing = await app.request("https://example.test/login", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "company_id=1&email=nobody%40example.test&password=wrong",
    }, env);
    expect(missing.status).toBe(403);

    const validToken = await app.request("https://example.test/login", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", Cookie: cookie.split(";", 1)[0]! },
      body: new URLSearchParams({ csrf_token: token!, company_id: "1", email: "nobody@example.test", password: "wrong" }),
    }, env);
    expect(validToken.status).toBe(401);

    const registration = await app.request("https://example.test/register", {}, env);
    expect(await registration.text()).not.toContain("invite_key");
    const registerWithoutToken = await app.request("https://example.test/register", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "company_id=1",
    }, env);
    expect(registerWithoutToken.status).toBe(403);
  });
});

describe("action permissions and active-company isolation", () => {
  it("denies payment editing without edit permission before reading the payment", async () => {
    db.role = "VIEWER";
    const response = await request("/finance/payments/10/edit");
    expect(response.status).toBe(403);
    expect(db.statements.some((statement) => statement.query.includes("FROM payments WHERE id=?"))).toBe(false);
  });

  it("binds payment, transaction, and stock-book edit reads to the active company", async () => {
    for (const [path, table] of [["/finance/payments/10/edit", "payments"], ["/transactions/purchase/10/edit", "purchases"], ["/masters/stock-books/10/edit", "stock_books"]] as const) {
      db.statements.length = 0;
      const response = await request(path);
      expect(response.status).toBe(200);
      const statement = db.statements.find((candidate) => candidate.query.includes(`FROM ${table} WHERE id=?`));
      expect(statement?.query).toContain("company_id=?");
      expect(statement?.params.slice(0, 2)).toEqual([10, 1]);
    }
  });

  it("returns not found instead of exposing a record outside the active company", async () => {
    expect((await request("/finance/payments/20/edit")).status).toBe(404);
    expect((await request("/transactions/purchase/20/edit")).status).toBe(404);
    expect((await request("/masters/stock-books/20/edit")).status).toBe(404);
  });

  it("requires both opening lifecycle identity and active-company scope", async () => {
    const response = await request("/transactions/opening/receivable/10/edit");
    expect(response.status).toBe(200);
    const statement = db.statements.find((candidate) => candidate.query.startsWith("SELECT * FROM receivables WHERE id=?"));
    expect(statement?.query).toContain("is_opening=1");
    expect(statement?.query).toContain("company_id=?");
    expect(statement?.params).toEqual([10, 1]);
  });

  it("uses an opening-stock form without purchase-only supplier and document-type fields", async () => {
    db.statements.length = 0;
    const response = await request("/transactions/opening/stock/new");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('name="supplier_id"');
    expect(html).not.toContain('name="document_type"');
    expect(db.statements.some((statement) => statement.query.includes("FROM suppliers"))).toBe(false);
  });

  it("preserves due date and CASH type when editing a purchase", async () => {
    const html=await (await request("/transactions/purchase/10/edit")).text();
    expect(html).toContain('name="due_date" value="2026-08-15"');
    expect(html).toContain('<option value="CASH" selected>CASH</option>');
  });

  it("preserves payment mode and the currently allocated target", async () => {
    const html=await (await request("/finance/payments/10/edit")).text();
    expect(html).toContain('<option value="BANK" selected>BANK</option>');
    expect(html).toContain('<option value="30" selected>');
  });

  it("preserves legacy OR permissions for payment and opening maintenance",async()=>{
    db.role="VIEWER";
    db.overrides=[{module:"payments",can_deactivate:1}];
    expect((await request("/finance/payments/10/edit")).status).toBe(200);
    db.role="STOCK";
    db.overrides=[];
    expect((await request("/transactions/opening/receivable/10/edit")).status).toBe(200);
  });

  it("allows view-only users to export transaction entries as in legacy",async()=>{
    db.role="VIEWER";
    expect((await request("/transactions/purchase/10/export/csv")).status).toBe(200);
  });

  it("lets an all-company administrator choose a company when creating payments", async () => {
    db.companyId=null;
    const html=await (await request("/finance/payments")).text();
    expect(html).toContain('<select name="company_id" required>');
    expect(html).not.toContain('<input type="hidden" name="company_id" value="">');
  });

  it("renders payment references so records can be identified and maintained", async () => {
    const html=await (await request("/finance/payments")).text();
    expect(html).toContain('<section class="grid two">');
    expect(html).toContain('<form method="post" action="/finance/payments/customer-receipt" class="form-stack">');
    expect(html).toContain('<form method="post" action="/finance/payments/supplier-payment" class="form-stack">');
    expect(html).toContain("Recent Payments");
    expect(html).toContain("<th>Reference</th>");
    expect(html).toContain("<th>Created By</th>");
    expect(html).toContain("PAY-REFERENCE-10");
    expect(html).toContain('href="/finance/payments/10/export/pdf"');
    expect(html).toContain('href="/finance/payments/10/export/xlsx"');
    expect(html).toContain('href="/finance/payments/10/edit"');
    const list=db.statements.find(statement=>statement.query.includes("FROM payments p JOIN companies"));
    expect(list?.query).toContain("LIMIT ? OFFSET ?");
    expect(list?.params.slice(-2)).toEqual([51,0]);
  });

  it("keeps global user administration unscoped after selecting a workspace",async()=>{
    db.companyId=null;
    const signed=(await companyCookie(1,new Request("https://example.test"),env.SESSION_HMAC_KEY)).split(";",1)[0];
    const response=await app.request("https://example.test/users/",{headers:{Cookie:`fastock_session=session-token; fastock_csrf=csrf-token; ${signed}`}},env);
    expect(response.status).toBe(200);
    const query=db.statements.find(statement=>statement.query.includes("FROM users u LEFT JOIN companies"));
    expect(query?.query).not.toContain("WHERE u.company_id=?");
  });

  it("renders the legacy item and company configuration controls",async()=>{
    const item=await (await request("/masters/items/new")).text();
    expect(item).toContain('name="gst_percent"');
    expect(item).toContain('name="minimum_stock"');
    const company=await (await request("/masters/companies/new")).text();
    for(const field of ["allow_gst_purchase","allow_cash_purchase","allow_gst_sale","allow_cash_sale"])expect(company).toContain(`name="${field}"`);
  });

  it("stores item GST and minimum stock using D1 integer units",async()=>{
    const response=await request("/masters/items/new",{
      method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({csrf_token:"csrf-token",code:"I-1",name:"Item One",unit:"PCS",gst_percent:"5.5",minimum_stock:"1.25",active:"1"}),
    });
    expect(response.status).toBe(303);
    const insert=db.writes.find(statement=>statement.query.startsWith("INSERT INTO items"));
    expect(insert?.query).toContain("gst_basis_points");
    expect(insert?.query).toContain("minimum_stock_milliunits");
    expect(insert?.params).toContain(550);
    expect(insert?.params).toContain(1250);
  });

  it("renders pending stock with transfer companies, optional books, and quantity-only lines", async () => {
    const response = await request("/transactions/opening/pending-stock/new");
    expect(response.status).toBe(200);
    const html = await response.text();
    for (const name of ["from_company_id", "to_company_id", "from_stock_book_id", "to_stock_book_id", "transfer_date", "item_id[]", "quantity[]"]) expect(html).toContain(`name="${name}"`);
    expect(html).not.toContain('name="supplier_id"');
    expect(html).not.toContain('name="document_type"');
    expect(html).not.toContain('name="rate[]"');
  });

  it("exposes all six opening workflows with their correct simplified fields",async()=>{
    const index=await request("/transactions/opening"),indexHtml=await index.text();
    for(const section of ["stock","pending-stock","receivable","payable","advance-received","advance-paid"])expect(indexHtml).toContain(`/transactions/opening/${section}/new`);
    const receivable=await (await request("/transactions/opening/receivable/new")).text();
    for(const field of ["company_id","customer_id","sale_type","invoice_date","pending_amount"])expect(receivable).toContain(`name="${field}"`);
    const advance=await (await request("/transactions/opening/advance-paid/new")).text();
    for(const field of ["company_id","supplier_id","payment_date","mode","amount"])expect(advance).toContain(`name="${field}"`);
  });

  it("bounds eager form option reads and exposes server-side option search", async () => {
    db.statements.length = 0;
    await request("/finance/payments/10/edit?party_q=acme");
    await request("/transactions/purchase/10/edit?option_q=bolt");
    const optionReads = db.statements.filter((statement) => /FROM (customers|suppliers|items|receivables|payables)/.test(statement.query));
    expect(optionReads.length).toBeGreaterThan(0);
    expect(optionReads.every((statement) => statement.query.includes("LIMIT 100"))).toBe(true);
    expect(optionReads.every((statement) => !statement.query.includes("LIMIT 500"))).toBe(true);
    expect(optionReads.some((statement) => statement.params.includes("acme%"))).toBe(true);
    expect(optionReads.some((statement) => statement.params.includes("bolt%"))).toBe(true);
  });

  it("returns genuine XLSX and PDF bodies for transaction and payment exports", async () => {
    for (const path of ["/finance/payments/10/export/xlsx", "/transactions/purchase/10/export/xlsx"]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("spreadsheetml.sheet");
      expect(Array.from(new Uint8Array(await response.arrayBuffer()).slice(0, 2))).toEqual([0x50, 0x4b]);
    }
    for (const path of ["/finance/payments/10/export/pdf", "/transactions/purchase/10/export/pdf"]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/pdf");
      expect(new TextDecoder().decode((await response.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    }
  });
});

describe("permission override administration", () => {
  it("renders persisted tri-state overrides and saves explicit denies", async () => {
    db.overrides = [{ module: "sale", can_edit: 0 }];
    const form = await request("/users/7/edit");
    expect(form.status).toBe(200);
    expect(await form.text()).toMatch(/name="perm__sale__edit"[\s\S]*?<option value="deny" selected>Deny<\/option>/);

    db.writes.length = 0;
    const saved = await request("/users/7/edit", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "csrf_token=csrf-token&name=Guard+Tester&email=guard%40example.test&company_id=1&role=VIEWER&active=1&perm__sale__edit=deny",
    });
    expect(saved.status).toBe(303);
    const override = db.writes.find((statement) => statement.query.startsWith("INSERT INTO permission_overrides") && statement.params[1] === "sale");
    expect(override?.params).toEqual([7, "sale", null, null, 0, null, null, null]);
    expect(db.writes.some((statement) => statement.query.startsWith("DELETE FROM permission_overrides") && statement.params[0] === 7)).toBe(true);
  });
});
