import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL("../../migrations/0007_serverless_read_indexes.sql", import.meta.url);
const wrangler = new URL("../../wrangler.jsonc", import.meta.url);

test("serverless read migration keeps only the reviewed non-overlapping access paths", async () => {
  const sql = await readFile(migration, "utf8");
  const indexes = [...sql.matchAll(/CREATE INDEX\s+(\w+)/g)].map((match) => match[1]);
  assert.deepEqual(indexes, [
    "idx_sales_customer_profile", "idx_receivables_customer_profile",
    "idx_payments_customer_profile", "idx_purchases_supplier_profile",
    "idx_payables_supplier_profile", "idx_payments_supplier_profile",
    "idx_opening_stock_lines_opening", "idx_purchase_lines_purchase",
    "idx_sale_lines_sale", "idx_transfer_lines_transfer",
  ]);
  assert.match(sql, /sales\(customer_id,invoice_date DESC,id DESC,company_id\)/);
  assert.match(sql, /receivables\(customer_id,company_id,document_date DESC,id DESC\)/);
  assert.match(sql, /payments\(customer_id,payment_date DESC,id DESC,company_id\)/);
  assert.match(sql, /sale_lines\(sale_id,id\)/);
  assert.match(sql, /purchases\(supplier_id,bill_date DESC,id DESC,company_id\)/);
  assert.match(sql, /payables\(supplier_id,company_id,document_date DESC,id DESC\)/);
  assert.match(sql, /payments\(supplier_id,payment_date DESC,id DESC,company_id\)/);
  assert.match(sql, /opening_stock_lines\(opening_stock_id,id\)/);
  assert.match(sql, /purchase_lines\(purchase_id,id\)/);
  assert.match(sql, /transfer_lines\(transfer_id,id\)/);
});

test("worker advertises the matching customer profile schema", async () => {
  const config = await readFile(wrangler, "utf8");
  assert.match(config, /"SCHEMA_VERSION"\s*:\s*"0008"/);
});
