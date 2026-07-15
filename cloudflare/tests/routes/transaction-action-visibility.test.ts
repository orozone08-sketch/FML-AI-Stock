import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/app";
import { sha256 } from "../../src/security/crypto";
import type { Env } from "../../src/types";

type Row = Record<string, unknown>;

class Statement {
  params: unknown[] = [];
  constructor(readonly query: string, private readonly db: VisibilityDb) {}
  bind(...params: unknown[]) { this.params = params; return this; }
  first<T>() { return Promise.resolve(this.db.first(this.query) as T); }
  all<T>() { return Promise.resolve({ results: this.db.all(this.query, this.params) } as T); }
}

class VisibilityDb {
  csrfDigest = "";
  transferRows: Row[] = [];
  pendingRows: Row[] = [];
  scopedTransfer: Row | null = null;
  statements: Statement[] = [];
  prepare(query: string) { const statement = new Statement(query, this); this.statements.push(statement); return statement; }
  first(query: string): Row | null {
    if (query.includes("FROM sessions s JOIN users u")) return {
      session_id: 1, csrf_digest: this.csrfDigest, id: 1, name: "Admin", email: "admin@example.test",
      role: "ADMIN", company_id: 1, force_password_change: 0,
    };
    if (query.includes("FROM inter_company_transfers") && query.includes("WHERE id=?")) return this.scopedTransfer;
    return null;
  }
  all(query: string, _params: unknown[]): Row[] {
    if (query.includes("FROM permission_overrides")) return [];
    if (query.includes("FROM inter_company_transfers") && query.includes("number") && !query.includes("OPENING_PENDING_STOCK")) return this.transferRows;
    if (query.includes("FROM inter_company_transfers") && query.includes("OPENING_PENDING_STOCK")) return this.pendingRows;
    return [];
  }
  batch<T>(statements: Statement[]) {
    return Promise.resolve(statements.map((statement) => ({ results: this.all(statement.query, statement.params) })) as T);
  }
}

function environment(db: VisibilityDb): Env {
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

let db: VisibilityDb;
let currentEnv: Env;
const get = (path: string) => app.request(`https://example.test${path}`, {
  headers: { Cookie: "fastock_session=session-token; fastock_csrf=csrf-token" },
}, currentEnv);

beforeEach(async () => {
  db = new VisibilityDb();
  db.csrfDigest = await sha256("csrf-token");
  currentEnv = environment(db);
});

describe("transfer and opening action visibility", () => {
  it("does not render mutation actions to the destination company", async () => {
    db.transferRows = [{ id: 10, number: "TR-10", date: "2026-01-01", total: 100, status: "ACTIVE", from_company_id: 2, to_company_id: 1, reason: null }];
    const html = await (await get("/transactions/transfer")).text();
    expect(html).toContain("TR-10");
    expect(html).not.toContain('/transactions/transfer/10/edit');
    expect(html).not.toContain('/transactions/transfer/10/delete');
    expect(html).toContain('/transactions/transfer/10/print');
  });

  it("keeps opening-pending transfers read-only in the normal transfer list", async () => {
    db.transferRows = [{ id: 11, number: "OP-11", date: "2026-01-01", total: 0, status: "ACTIVE", from_company_id: 1, to_company_id: 2, reason: "OPENING_PENDING_STOCK" }];
    const html = await (await get("/transactions/transfer")).text();
    expect(html).toContain("OP-11");
    expect(html).not.toContain('/transactions/transfer/11/edit');
  });

  it("rejects a manually entered opening-pending edit URL with explicit recreate semantics", async () => {
    db.scopedTransfer = { id: 11, from_company_id: 1, to_company_id: 2, reason: "OPENING_PENDING_STOCK" };
    const response = await get("/transactions/transfer/11/edit");
    expect(response.status).toBe(409);
    expect(await response.text()).toMatch(/read-only; delete and recreate/);
  });

  it("lists opening-pending snapshots under opening entries with two-sided company scope", async () => {
    db.pendingRows = [{ id: 12, date: "2026-01-01", ref: "OP-12", type: "pending stock" }];
    const html = await (await get("/transactions/opening")).text();
    expect(html).toContain("OP-12");
    expect(html).toContain("pending stock");
    const query = db.statements.find((statement) => statement.query.includes("reason='OPENING_PENDING_STOCK'"));
    expect(query?.query).toContain("(from_company_id=? OR to_company_id=?)");
    expect(query?.params).toEqual([1, 1]);
  });
});
