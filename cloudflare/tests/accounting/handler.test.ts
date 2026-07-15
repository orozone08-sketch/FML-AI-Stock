import { describe, expect, it } from "vitest";
import { AccountingHandler } from "../../src/accounting";

class Statement {
  params: unknown[] = [];
  constructor(readonly query: string, private readonly firstValue: unknown = null) {}
  bind(...params: unknown[]) { this.params = params; return this; }
  first<T>() { return Promise.resolve(this.firstValue as T); }
  all<T>() { return Promise.resolve({ results: [] as T[] }); }
}

class FakeDb {
  batches: Statement[][] = [];
  replay: unknown = null;
  prepare(query: string) {
    const first = query.startsWith("SELECT request_digest") ? this.replay
      : query.includes("FROM items") ? { count: 1 }
      : query.includes("FROM companies") || query.includes("FROM stock_books") ? { id: 1 }
      : null;
    return new Statement(query, first);
  }
  batch<T>(statements: Statement[]) {
    this.batches.push(statements);
    if (statements.every((row) => row.query.startsWith("SELECT COALESCE(MAX"))) return Promise.resolve(statements.map(() => ({ results: [{ id: 1 }] })) as T);
    return Promise.resolve(statements.map(() => ({ success: true, results: [] })) as T);
  }
}

const opening = {
  type: "opening.create", userId: 1, companyId: 1, idempotencyKey: "one", requestDigest: "digest",
  payload: { companyId: 1, stockBookId: 1, referenceNumber: "OP-1", date: "2026-01-01", lines: [{ itemId: 1, quantity: "2", rate: "10" }] },
};

describe("AccountingHandler atomic command execution", () => {
  it("puts the document, FIFO, ledger, balance, audit and idempotency transition in one final batch", async () => {
    const db = new FakeDb();
    const result = await new AccountingHandler(db as unknown as D1Database).execute(opening);
    expect(result).toEqual({ type: "OpeningStock", id: 1, status: "created" });
    const final = db.batches.at(-1)!;
    const combined = final.map((statement) => statement.query).join("\n");
    expect(combined).toContain("INSERT INTO idempotency_keys");
    expect(combined).toContain("INSERT INTO opening_stocks");
    expect(combined).toContain("INSERT INTO fifo_layers");
    expect(combined).toContain("INSERT INTO stock_ledger_entries");
    expect(combined).toContain("INSERT INTO inventory_balances");
    expect(combined).toContain("INSERT INTO audit_logs");
    const audit = db.batches.at(-1)!.find((statement) => statement.query.startsWith("INSERT INTO audit_logs"))!;
    expect(audit.query).toContain("company_id");
    expect(audit.params).toContain(1);
    expect(combined).toContain("SET status='COMMITTED'");
  });

  it("replays a committed command without issuing a write batch", async () => {
    const db = new FakeDb();
    db.replay = { request_digest: "digest", status: "COMMITTED", result_type: "OpeningStock", result_id: 9 };
    await expect(new AccountingHandler(db as unknown as D1Database).execute(opening)).resolves.toEqual({ type: "OpeningStock", id: 9, status: "created", replayed: true });
    expect(db.batches).toHaveLength(0);
  });

  it("rejects reuse of an idempotency key with a different request", async () => {
    const db = new FakeDb();
    db.replay = { request_digest: "other", status: "COMMITTED", result_type: "OpeningStock", result_id: 9 };
    await expect(new AccountingHandler(db as unknown as D1Database).execute(opening)).rejects.toThrow(/different request/);
  });

  it("rejects an edit or void when the document is outside the active company", async () => {
    const db = new FakeDb();
    await expect(new AccountingHandler(db as unknown as D1Database).execute({
      type: "sale.void", userId: 1, companyId: 1, idempotencyKey: "scope", requestDigest: "scope-digest",
      payload: { id: 99, companyId: 1 },
    })).rejects.toThrow(/selected company/);
    expect(db.batches).toHaveLength(0);
  });
});
