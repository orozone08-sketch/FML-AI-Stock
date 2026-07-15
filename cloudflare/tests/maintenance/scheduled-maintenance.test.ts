import { describe, expect, it } from "vitest";
import { MAINTENANCE_LIMITS, runScheduledMaintenance } from "../../src/maintenance";
import type { Env } from "../../src/types";

type DbRow = Record<string, number | string | null>;
class Statement {
  params: unknown[] = [];
  constructor(readonly db: FakeDb, readonly query: string) {}
  bind(...values: unknown[]) { this.params = values; return this; }
  async run() {
    this.db.runs.push(this);
    const table = /DELETE FROM (\w+)/.exec(this.query)?.[1];
    return { success: true, meta: { changes: table ? (this.db.deleteChanges[table] ?? 0) : 0 } };
  }
  async first<T>() {
    this.db.firsts.push(this);
    return (this.query.includes("maintenance_cursors") ? this.db.cursor : null) as T | null;
  }
  async all<T>() {
    this.db.alls.push(this);
    if (this.query.includes("FROM r2_objects")) return { success: true, results: this.db.r2Rows as T[] };
    if (this.query.includes("WITH slice AS")) return { success: true, results: this.db.balanceRows as T[] };
    if (this.query.includes("WITH ledger_slice AS")) return { success: true, results: this.db.ledgerRows as T[] };
    return { success: true, results: [] as T[] };
  }
}

class FakeDb {
  deleteChanges: Record<string, number> = { sessions: 4, login_attempts: 7, idempotency_keys: 3 };
  cursor: DbRow | null = null;
  r2Rows: DbRow[] = [];
  balanceRows: DbRow[] = [];
  ledgerRows: DbRow[] = [];
  runs: Statement[] = [];
  firsts: Statement[] = [];
  alls: Statement[] = [];
  batches: Statement[][] = [];
  prepare(query: string) { return new Statement(this, query); }
  async batch(statements: Statement[]) { this.batches.push(statements); return statements.map(() => ({ success: true, meta: {} })); }
}

const envFor = (db: FakeDb, deleted: string[]): Env => ({
  DB: db as unknown as D1Database,
  FILES: { delete: async (key: string) => { deleted.push(key); } } as unknown as R2Bucket,
} as Env);

describe("scheduled maintenance", () => {
  it("bounds retention, cleans aged R2 metadata, and raises one reconciliation alert", async () => {
    const db = new FakeDb(), deleted: string[] = [];
    db.r2Rows = [{ id: 8, object_key: "companies/1/orphan" }];
    db.balanceRows = [{ company_id: 1, stock_book_id: 2, item_id: 3, quantity_milliunits: 900, ledger_value_paise: 500, expected_quantity_milliunits: 1000, expected_ledger_value_paise: 500, alert_id: null }];
    const result = await runScheduledMaintenance(envFor(db, deleted), new Date("2026-07-15T12:00:00.000Z"));

    expect(result).toEqual({ deleted: { sessions: 4, loginAttempts: 7, idempotencyKeys: 3, r2Objects: 1 }, reconciliation: { phase: "BALANCES", checked: 1, mismatches: 1, reset: false } });
    expect(deleted).toEqual(["companies/1/orphan"]);
    expect(db.runs.map((s) => s.params.at(-1))).toEqual([MAINTENANCE_LIMITS.sessions, MAINTENANCE_LIMITS.loginAttempts, MAINTENANCE_LIMITS.idempotencyKeys]);
    expect(db.runs[1]?.params[0]).toBe("2026-06-15T12:00:00.000Z");
    expect(db.alls.find((s) => s.query.includes("FROM r2_objects"))?.params).toEqual(["2026-07-14T12:00:00.000Z", MAINTENANCE_LIMITS.r2Objects]);
    const batchedSql = db.batches.flat().map((s) => s.query).join("\n");
    expect(batchedSql).toContain("DELETE FROM r2_objects");
    expect(batchedSql).toContain("INSERT INTO alerts");
    expect(batchedSql).toContain("cursor_company_id=excluded.cursor_company_id");
  });

  it("uses the persisted ledger cursor and switches phases after an exhausted slice", async () => {
    const db = new FakeDb(), deleted: string[] = [];
    db.deleteChanges = {};
    db.cursor = { phase: "LEDGER", cursor_company_id: 0, cursor_stock_book_id: 0, cursor_item_id: 0, cursor_ledger_id: 55 };
    const result = await runScheduledMaintenance(envFor(db, deleted), new Date("2026-07-15T12:00:00.000Z"));

    expect(result.reconciliation).toEqual({ phase: "LEDGER", checked: 0, mismatches: 0, reset: true });
    expect(db.alls.find((s) => s.query.includes("WITH ledger_slice AS"))?.params).toEqual([55, MAINTENANCE_LIMITS.reconciliationKeys]);
    const reset = db.batches.flat().find((s) => s.query.includes("cursor_ledger_id=0"));
    expect(reset?.params[0]).toBe("BALANCES");
  });

  it("resolves an existing alert when the read model matches the ledger", async () => {
    const db = new FakeDb(), deleted: string[] = [];
    db.deleteChanges = {};
    db.balanceRows = [{ company_id: 1, stock_book_id: 1, item_id: 1, quantity_milliunits: -500, ledger_value_paise: 0, expected_quantity_milliunits: -500, expected_ledger_value_paise: 0, alert_id: 19 }];
    const result = await runScheduledMaintenance(envFor(db, deleted), new Date("2026-07-15T12:00:00.000Z"));
    expect(result.reconciliation.mismatches).toBe(0);
    const resolution = db.batches.flat().find((s) => s.query.startsWith("UPDATE alerts SET resolved=1"));
    expect(resolution?.params).toEqual([19]);
  });
});

