import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../../migrations/0008_dashboard_read_indexes.sql", import.meta.url), "utf8");

test("all-company dashboard indexes cover only active or open working sets", () => {
  for (const marker of [
    "idx_sales_active_date",
    "idx_purchases_active_date",
    "idx_receivables_open_due_all",
    "idx_payables_open_due_all",
    "idx_inter_company_pending_due_all",
    "WHERE is_void=0",
    "WHERE balance_amount_paise>0",
    "WHERE status='PENDING'",
  ]) assert.ok(migration.includes(marker), `missing dashboard index marker: ${marker}`);
});
