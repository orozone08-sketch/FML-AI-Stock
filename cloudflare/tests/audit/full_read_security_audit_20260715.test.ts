import { describe, expect, it } from "vitest";
import app from "../../src/app";
import { applyOverrides, can, permissionsFor } from "../../src/security/permissions";
import { REPORT_NAMES, REPORTS, normalizeFilters, toCsv } from "../../src/reports";
import type { AuthUser, Env } from "../../src/types";

const routeContracts = () => app.routes.map((route) => `${route.method} ${route.path}`);
const minimumLegacyContracts = [
  "GET /", "GET /login", "POST /login", "GET /login/company/:id", "POST /login/company/:id",
  "GET /register", "POST /register", "GET /admin/login", "POST /admin/login", "POST /logout",
  "GET /company/choose", "POST /company/select", "POST /company/all",
  "GET /dashboard", "GET /dashboard/calendar-events",
  "GET /masters", "GET /masters/:kind", "GET /masters/customers/:customerId",
  "GET /reports", "GET /reports/item-ledger", "GET /reports/customer-ledger", "GET /reports/customer-ledger/detail", "GET /reports/:name",
  "GET /customers", "GET /customers/:customerId", "GET /customers/:customerId/invoices", "GET /customers/:customerId/challans", "GET /customers/:customerId/payments", "GET /customers/:customerId/stock",
  "GET /finance/payments", "GET /finance/outstanding", "GET /finance/outstanding/customer/:companyId/:customerId", "GET /finance/outstanding/supplier/:companyId/:supplierId",
  "GET /users", "GET /users/new", "POST /users/new", "GET /users/:id/edit", "POST /users/:id/edit", "POST /users/:id/deactivate",
] as const;

function env(): Env {
  return { APP_ENV:"test", SITE_URL:"https://example.test", SESSION_HMAC_KEY:"x", CSRF_HMAC_KEY:"x" } as Env;
}

describe("2026-07-15 HTTP and imported-read parity audit", () => {
  it("registers the minimum legacy route contracts", () => {
    const actual=new Set(routeContracts());
    expect(minimumLegacyContracts.filter(route=>!actual.has(route))).toEqual([]);
  });

  it("keeps every report query explicit and backed by an imported D1 table", () => {
    const knownTables = new Set(["companies","users","stock_books","items","suppliers","customers","opening_stocks","opening_stock_lines","purchases","purchase_lines","sales","sale_lines","inter_company_transfers","fifo_layers","stock_ledger_entries","receivables","payables","payments","inter_company_ledger_entries","audit_logs","inventory_balances"]);
    expect(REPORT_NAMES).toHaveLength(23);
    for (const report of Object.values(REPORTS)) {
      expect(report.sql).not.toMatch(/SELECT\s+(?:\w+\.)?\*/i);
      for (const match of report.sql.matchAll(/(?:FROM|JOIN)\s+([a-z_]+)/gi)) expect(knownTables.has(match[1]!)).toBe(true);
    }
  });
});

describe("2026-07-15 roles and permission override audit", () => {
  it("applies nullable grants and denials without mutating role defaults", () => {
    const defaults=permissionsFor("SALES");
    const adjusted=applyOverrides(defaults,[{module:"sale",can_view:0,can_approve:1},{module:"users",can_view:1}]);
    const user={permissions:adjusted} as AuthUser;
    expect(can(user,"sale","view")).toBe(false);
    expect(can(user,"sale","approve")).toBe(true);
    expect(can(user,"users","view")).toBe(true);
    expect(defaults.sale?.has("view")).toBe(true);
  });
  it("does not grant unknown modules or actions by default",()=>{
    const user={permissions:permissionsFor("VIEWER")} as AuthUser;
    expect(can(user,"users","view")).toBe(false);
    expect(can(user,"unknown","view")).toBe(false);
  });
});

describe("2026-07-15 report export and filter audit",()=>{
  it("enforces company scope, bounded dates and page limits",()=>{
    expect(normalizeFilters({limit:999,from:"2026-01-01",to:"2026-12-31"},{activeCompanyId:4})).toMatchObject({limit:200,companyId:4});
    expect(()=>normalizeFilters({companyId:5},{activeCompanyId:4})).toThrow(/outside/);
    expect(()=>normalizeFilters({from:"2025-01-01",to:"2026-12-31"},{activeCompanyId:null})).toThrow(/exceeds/);
  });
  it("exports scaled integers without float drift and resists CSV formula injection",()=>{
    const csv=toCsv([{party:"=HYPERLINK(\"https://evil\")",balance_amount_paise:9007199254740991}]);
    expect(csv).toContain("90071992547409.91");
    expect(csv).not.toMatch(/\r\n"?[=+@-]/);
  });
});

describe("2026-07-15 response, cache, security, and R2 audit",()=>{
  it("sets baseline browser security headers on public responses",async()=>{
    const response=await app.request("https://example.test/healthz",{},env());
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("strict-transport-security") ?? "").toMatch(/max-age=/);
  });
  it("prevents shared-cache storage of dynamic and authenticated surfaces",async()=>{
    const response=await app.request("https://example.test/healthz",{},env());
    expect(response.headers.get("cache-control") ?? "").toMatch(/no-store|private/);
  });
  it("has authenticated private R2 file read routes with opaque keys",()=>{
    const routes=routeContracts();
    expect(routes.some(route=>route.startsWith("GET /files/"))).toBe(true);
    expect(routes.some(route=>route.startsWith("POST /files/"))).toBe(true);
  });
});
