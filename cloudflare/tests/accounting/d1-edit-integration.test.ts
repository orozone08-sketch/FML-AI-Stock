/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { prepared, sql } from "../../src/accounting/sql";
import { planPurchaseEdit } from "../../src/accounting/purchase-edit";
import { planTransferEdit } from "../../src/accounting/transfer-edit";
import { AccountingHandler } from "../../src/accounting/handler";

declare global {
  namespace Cloudflare {
    interface Env { DB: D1Database }
  }
}

const schema = `
PRAGMA foreign_keys=OFF;
DROP TABLE IF EXISTS inter_company_ledger_entries; DROP TABLE IF EXISTS inventory_balances;
DROP TABLE IF EXISTS stock_ledger_entries; DROP TABLE IF EXISTS fifo_consumptions; DROP TABLE IF EXISTS fifo_layers;
DROP TABLE IF EXISTS transfer_lines; DROP TABLE IF EXISTS inter_company_transfers; DROP TABLE IF EXISTS sale_lines;
DROP TABLE IF EXISTS sales; DROP TABLE IF EXISTS purchase_lines; DROP TABLE IF EXISTS purchases; DROP TABLE IF EXISTS payables;
DROP TABLE IF EXISTS suppliers; DROP TABLE IF EXISTS items; DROP TABLE IF EXISTS stock_books; DROP TABLE IF EXISTS companies;
DROP TABLE IF EXISTS audit_logs; DROP TABLE IF EXISTS idempotency_keys;
CREATE TABLE companies(id INTEGER PRIMARY KEY,name TEXT,active INTEGER NOT NULL,allow_gst_purchase INTEGER NOT NULL,allow_cash_purchase INTEGER NOT NULL,allow_gst_sale INTEGER NOT NULL,allow_cash_sale INTEGER NOT NULL);
CREATE TABLE stock_books(id INTEGER PRIMARY KEY,company_id INTEGER NOT NULL,active INTEGER NOT NULL,book_type TEXT NOT NULL);
CREATE TABLE items(id INTEGER PRIMARY KEY,active INTEGER NOT NULL);
CREATE TABLE suppliers(id INTEGER PRIMARY KEY,active INTEGER NOT NULL);
CREATE TABLE purchases(id INTEGER PRIMARY KEY,company_id INTEGER,stock_book_id INTEGER,supplier_id INTEGER,purchase_type TEXT,bill_number TEXT,bill_date TEXT,due_date TEXT,subtotal_paise INTEGER,gst_total_paise INTEGER,grand_total_paise INTEGER,paid_amount_paise INTEGER,balance_amount_paise INTEGER,payment_status TEXT,remarks TEXT,is_void INTEGER,updated_at TEXT,updated_by_id INTEGER);
CREATE TABLE purchase_lines(id INTEGER PRIMARY KEY,purchase_id INTEGER,item_id INTEGER,quantity_milliunits INTEGER,rate_ten_thousandths INTEGER,gst_basis_points INTEGER,subtotal_paise INTEGER,gst_amount_paise INTEGER,line_total_paise INTEGER);
CREATE TABLE sales(id INTEGER PRIMARY KEY,subtotal_paise INTEGER,fifo_cost_paise INTEGER,gross_profit_paise INTEGER);
CREATE TABLE sale_lines(id INTEGER PRIMARY KEY,sale_id INTEGER,item_id INTEGER,subtotal_paise INTEGER,fifo_cost_paise INTEGER,gross_profit_paise INTEGER);
CREATE TABLE inter_company_transfers(id INTEGER PRIMARY KEY,from_company_id INTEGER,from_stock_book_id INTEGER,to_company_id INTEGER,to_stock_book_id INTEGER,reference_number TEXT,transfer_date TEXT,reason TEXT,remarks TEXT,total_fifo_value_paise INTEGER,mismatch_approved INTEGER,approval_reason TEXT,approved_by_id INTEGER,approved_at TEXT,is_void INTEGER NOT NULL DEFAULT 0,created_at TEXT,updated_at TEXT,created_by_id INTEGER,updated_by_id INTEGER);
CREATE TABLE transfer_lines(id INTEGER PRIMARY KEY,transfer_id INTEGER,item_id INTEGER,quantity_milliunits INTEGER,fifo_value_paise INTEGER);
CREATE TABLE fifo_layers(id INTEGER PRIMARY KEY,company_id INTEGER,stock_book_id INTEGER,item_id INTEGER,source_type TEXT,source_id INTEGER,source_line_id INTEGER,source_reference TEXT,source_date TEXT,original_quantity_milliunits INTEGER,available_quantity_milliunits INTEGER,unit_cost_ten_thousandths INTEGER,original_value_paise INTEGER,available_value_paise INTEGER,status TEXT,created_at TEXT,updated_at TEXT,created_by_id INTEGER,updated_by_id INTEGER);
CREATE TABLE fifo_consumptions(id INTEGER PRIMARY KEY,fifo_layer_id INTEGER,source_type TEXT,source_id INTEGER,source_line_id INTEGER,quantity_milliunits INTEGER,rate_ten_thousandths INTEGER,value_paise INTEGER,created_at TEXT);
CREATE TABLE stock_ledger_entries(id INTEGER PRIMARY KEY,company_id INTEGER,stock_book_id INTEGER,item_id INTEGER,entry_date TEXT,movement_type TEXT,transaction_type TEXT,transaction_id INTEGER,reference_number TEXT,quantity_in_milliunits INTEGER,quantity_out_milliunits INTEGER,rate_ten_thousandths INTEGER,value_paise INTEGER,created_at TEXT,created_by_id INTEGER);
CREATE TABLE inventory_balances(company_id INTEGER,stock_book_id INTEGER,item_id INTEGER,quantity_milliunits INTEGER,ledger_value_paise INTEGER,version INTEGER,updated_at TEXT,PRIMARY KEY(company_id,stock_book_id,item_id));
CREATE TABLE payables(id INTEGER PRIMARY KEY,company_id INTEGER,stock_book_id INTEGER,supplier_id INTEGER,source_type TEXT,source_id INTEGER,document_number TEXT,document_date TEXT,due_date TEXT,transaction_type TEXT,total_amount_paise INTEGER,paid_amount_paise INTEGER,balance_amount_paise INTEGER,payment_status TEXT,remarks TEXT,updated_at TEXT,updated_by_id INTEGER);
CREATE TABLE inter_company_ledger_entries(id INTEGER PRIMARY KEY,stock_owner_company_id INTEGER,stock_user_company_id INTEGER,transfer_id INTEGER,item_id INTEGER,quantity_milliunits INTEGER,amount_owed_paise INTEGER,settled_amount_paise INTEGER,balance_amount_paise INTEGER,status TEXT,created_at TEXT,updated_at TEXT,created_by_id INTEGER);
CREATE TABLE idempotency_keys(id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT,idempotency_key TEXT,request_digest TEXT,status TEXT,result_type TEXT,result_id INTEGER,response_status INTEGER,created_at TEXT,expires_at TEXT);
CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,user_id INTEGER,company_id INTEGER,action TEXT,entity_type TEXT,entity_id TEXT,reference TEXT,before_values TEXT,after_values TEXT,created_at TEXT);
`;

async function seedDomain(): Promise<void> {
  await env.DB.exec(schema);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO companies VALUES(1,'A',1,1,1,1,1)"),
    env.DB.prepare("INSERT INTO companies VALUES(2,'B',1,1,1,1,1)"),
    env.DB.prepare("INSERT INTO stock_books VALUES(1,1,1,'CASH')"),
    env.DB.prepare("INSERT INTO stock_books VALUES(2,2,1,'CASH')"),
    env.DB.prepare("INSERT INTO items VALUES(4,1)"),
    env.DB.prepare("INSERT INTO items VALUES(5,1)"),
    env.DB.prepare("INSERT INTO suppliers VALUES(9,1)"),
  ]);
}

beforeEach(seedDomain);

describe("D1-backed accounting edit reconstruction", () => {
  it("reconciles reordered multi-line purchase FIFO, downstream cost, payable, and exact inventory balances", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO purchases VALUES(7,1,1,9,'CASH','P-OLD','2026-01-01',NULL,2000,0,2000,0,2000,'UNPAID',NULL,0,'t',NULL)"),
      env.DB.prepare("INSERT INTO purchase_lines VALUES(21,7,4,10000,100000,0,1000,0,1000)"),
      env.DB.prepare("INSERT INTO purchase_lines VALUES(22,7,5,5000,200000,0,1000,0,1000)"),
      env.DB.prepare("INSERT INTO fifo_layers VALUES(31,1,1,4,'PURCHASE',7,21,'P-OLD','2026-01-01',10000,4000,100000,1000,400,'PARTIAL','t','t',1,NULL)"),
      env.DB.prepare("INSERT INTO fifo_layers VALUES(32,1,1,5,'PURCHASE',7,22,'P-OLD','2026-01-01',5000,5000,200000,1000,1000,'OPEN','t','t',1,NULL)"),
      env.DB.prepare("INSERT INTO stock_ledger_entries VALUES(41,1,1,4,'2026-01-01','IN','PURCHASE',7,'P-OLD',10000,0,100000,1000,'t',1)"),
      env.DB.prepare("INSERT INTO stock_ledger_entries VALUES(42,1,1,5,'2026-01-01','IN','PURCHASE',7,'P-OLD',5000,0,200000,1000,'t',1)"),
      env.DB.prepare("INSERT INTO sales VALUES(60,2000,600,1400)"),
      env.DB.prepare("INSERT INTO sale_lines VALUES(50,60,4,2000,600,1400)"),
      env.DB.prepare("INSERT INTO fifo_consumptions VALUES(70,31,'SALE',60,50,6000,100000,600,'t')"),
      env.DB.prepare("INSERT INTO stock_ledger_entries VALUES(43,1,1,4,'2026-01-02','OUT','SALE',60,'S-1',0,6000,100000,600,'t',1)"),
      env.DB.prepare("INSERT INTO inventory_balances VALUES(1,1,4,4000,400,1,'t')"),
      env.DB.prepare("INSERT INTO inventory_balances VALUES(1,1,5,5000,1000,1,'t')"),
      env.DB.prepare("INSERT INTO payables VALUES(80,1,1,9,'PURCHASE',7,'P-OLD','2026-01-01',NULL,'CASH',2000,0,2000,'UNPAID',NULL,'t',NULL)"),
    ]);

    const plan = await planPurchaseEdit(env.DB, {
      id: 7, companyId: 1, stockBookId: 1, supplierId: 9, documentType: "CASH",
      referenceNumber: "P-NEW", date: "2026-01-03",
      lines: [{ itemId: 5, quantity: "6", rate: "2.5" }, { itemId: 4, quantity: "10", rate: "1.5" }],
    }, 1);
    await env.DB.batch(prepared(env.DB, plan.mutations));

    await expect(env.DB.prepare("SELECT fifo_cost_paise FROM sale_lines WHERE id=50").first()).resolves.toMatchObject({ fifo_cost_paise: 900 });
    await expect(env.DB.prepare("SELECT value_paise FROM stock_ledger_entries WHERE id=43").first()).resolves.toMatchObject({ value_paise: 900 });
    await expect(env.DB.prepare("SELECT quantity_milliunits,ledger_value_paise FROM inventory_balances WHERE company_id=1 AND stock_book_id=1 AND item_id=4").first()).resolves.toMatchObject({ quantity_milliunits: 4000, ledger_value_paise: 600 });
    await expect(env.DB.prepare("SELECT quantity_milliunits,ledger_value_paise FROM inventory_balances WHERE company_id=1 AND stock_book_id=1 AND item_id=5").first()).resolves.toMatchObject({ quantity_milliunits: 6000, ledger_value_paise: 1500 });
    await expect(env.DB.prepare("SELECT total_amount_paise,balance_amount_paise FROM payables WHERE id=80").first()).resolves.toMatchObject({ total_amount_paise: 3000, balance_amount_paise: 3000 });
  });

  it("rolls the entire purchase reconstruction back when any D1 statement fails", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO purchases VALUES(7,1,1,9,'CASH','P-OLD','2026-01-01',NULL,1000,0,1000,0,1000,'UNPAID',NULL,0,'t',NULL)"),
      env.DB.prepare("INSERT INTO purchase_lines VALUES(21,7,4,10000,100000,0,1000,0,1000)"),
      env.DB.prepare("INSERT INTO fifo_layers VALUES(31,1,1,4,'PURCHASE',7,21,'P-OLD','2026-01-01',10000,10000,100000,1000,1000,'OPEN','t','t',1,NULL)"),
      env.DB.prepare("INSERT INTO stock_ledger_entries VALUES(41,1,1,4,'2026-01-01','IN','PURCHASE',7,'P-OLD',10000,0,100000,1000,'t',1)"),
      env.DB.prepare("INSERT INTO inventory_balances VALUES(1,1,4,10000,1000,1,'t')"),
      env.DB.prepare("INSERT INTO payables VALUES(80,1,1,9,'PURCHASE',7,'P-OLD','2026-01-01',NULL,'CASH',1000,0,1000,'UNPAID',NULL,'t',NULL)"),
    ]);
    const plan = await planPurchaseEdit(env.DB, {
      id: 7, companyId: 1, stockBookId: 1, supplierId: 9, documentType: "CASH",
      referenceNumber: "P-NEW", date: "2026-01-03", lines: [{ itemId: 4, quantity: "12", rate: "2" }],
    }, 1);
    const broken = [...plan.mutations];
    broken.splice(2, 0, sql("INSERT INTO table_that_does_not_exist VALUES(1)"));
    await expect(env.DB.batch(prepared(env.DB, broken))).rejects.toThrow();
    await expect(env.DB.prepare("SELECT bill_number FROM purchases WHERE id=7").first()).resolves.toMatchObject({ bill_number: "P-OLD" });
    await expect(env.DB.prepare("SELECT original_quantity_milliunits,unit_cost_ten_thousandths FROM fifo_layers WHERE id=31").first()).resolves.toMatchObject({ original_quantity_milliunits: 10000, unit_cost_ten_thousandths: 100000 });
  });

  it("rebuilds an issue transfer including permitted zero-cost negative stock", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO fifo_layers VALUES(31,1,1,4,'PURCHASE',7,21,'P-1','2026-01-01',10000,8000,10000,1000,800,'PARTIAL','t','t',1,NULL)"),
      env.DB.prepare("INSERT INTO stock_ledger_entries VALUES(49,1,1,4,'2026-01-01','IN','PURCHASE',7,'P-1',10000,0,10000,1000,'t',1)"),
      env.DB.prepare("INSERT INTO inter_company_transfers VALUES(10,1,1,2,2,'T-OLD','2026-01-02',NULL,NULL,200,0,NULL,NULL,NULL,0,'t','t',1,NULL)"),
      env.DB.prepare("INSERT INTO transfer_lines VALUES(20,10,4,2000,200)"),
      env.DB.prepare("INSERT INTO fifo_consumptions VALUES(40,31,'TRANSFER',10,20,2000,10000,200,'t')"),
      env.DB.prepare("INSERT INTO stock_ledger_entries VALUES(50,1,1,4,'2026-01-02','OUT','TRANSFER',10,'T-OLD',0,2000,10000,200,'t',1)"),
      env.DB.prepare("INSERT INTO inter_company_ledger_entries VALUES(60,1,2,10,4,2000,200,0,200,'PENDING','t','t',1)"),
      env.DB.prepare("INSERT INTO inventory_balances VALUES(1,1,4,8000,800,1,'t')"),
    ]);
    const plan = await planTransferEdit(env.DB, {
      id: 10, companyId: 1, stockBookId: 1, toCompanyId: 2, toStockBookId: 2,
      referenceNumber: "T-NEW", date: "2026-01-04", lines: [{ itemId: 4, quantity: "12", rate: "0" }],
    }, 1);
    await env.DB.batch(prepared(env.DB, plan.mutations));
    await expect(env.DB.prepare("SELECT available_quantity_milliunits FROM fifo_layers WHERE id=31").first()).resolves.toMatchObject({ available_quantity_milliunits: 0 });
    await expect(env.DB.prepare("SELECT SUM(quantity_out_milliunits) quantity,SUM(value_paise) value FROM stock_ledger_entries WHERE transaction_type='TRANSFER' AND transaction_id=10").first()).resolves.toMatchObject({ quantity: 12000, value: 1000 });
    await expect(env.DB.prepare("SELECT quantity_milliunits,ledger_value_paise FROM inventory_balances WHERE company_id=1 AND stock_book_id=1 AND item_id=4").first()).resolves.toMatchObject({ quantity_milliunits: -2000, ledger_value_paise: 0 });
    await expect(env.DB.prepare("SELECT quantity_milliunits,amount_owed_paise,balance_amount_paise FROM inter_company_ledger_entries WHERE transfer_id=10").first()).resolves.toMatchObject({ quantity_milliunits: 12000, amount_owed_paise: 1000, balance_amount_paise: 1000 });
  });

  it("rebuilds a return transfer into owner FIFO, ledger, balance, and signed inter-company read model", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO inter_company_transfers VALUES(9,1,1,2,2,'ISSUE','2026-01-01',NULL,NULL,500,0,NULL,NULL,NULL,0,'t','t',1,NULL)"),
      env.DB.prepare("INSERT INTO inter_company_ledger_entries VALUES(59,1,2,9,4,5000,500,0,500,'PENDING','t','t',1)"),
      env.DB.prepare("INSERT INTO inter_company_transfers VALUES(10,2,2,1,1,'R-OLD','2026-01-02',NULL,NULL,200,0,NULL,NULL,NULL,0,'t','t',1,NULL)"),
      env.DB.prepare("INSERT INTO transfer_lines VALUES(20,10,4,2000,200)"),
      env.DB.prepare("INSERT INTO fifo_layers VALUES(31,1,1,4,'TRANSFER_RETURN',10,20,'R-OLD','2026-01-02',2000,2000,100000,200,200,'OPEN','t','t',1,NULL)"),
      env.DB.prepare("INSERT INTO stock_ledger_entries VALUES(50,1,1,4,'2026-01-02','IN','TRANSFER',10,'R-OLD',2000,0,100000,200,'t',1)"),
      env.DB.prepare("INSERT INTO inter_company_ledger_entries VALUES(60,1,2,10,4,-2000,-200,0,0,'RETURNED','t','t',1)"),
      env.DB.prepare("INSERT INTO inventory_balances VALUES(1,1,4,2000,200,1,'t')"),
    ]);
    const plan = await planTransferEdit(env.DB, {
      id: 10, companyId: 2, stockBookId: 2, toCompanyId: 1, toStockBookId: 1,
      referenceNumber: "R-NEW", date: "2026-01-03", lines: [{ itemId: 4, quantity: "3", rate: "0" }],
    }, 1);
    await env.DB.batch(prepared(env.DB, plan.mutations));
    await expect(env.DB.prepare("SELECT original_quantity_milliunits,available_quantity_milliunits,original_value_paise FROM fifo_layers WHERE source_type='TRANSFER_RETURN' AND source_id=10").first()).resolves.toMatchObject({ original_quantity_milliunits: 3000, available_quantity_milliunits: 3000, original_value_paise: 300 });
    await expect(env.DB.prepare("SELECT quantity_milliunits,ledger_value_paise FROM inventory_balances WHERE company_id=1 AND stock_book_id=1 AND item_id=4").first()).resolves.toMatchObject({ quantity_milliunits: 3000, ledger_value_paise: 300 });
    await expect(env.DB.prepare("SELECT quantity_milliunits,amount_owed_paise,status FROM inter_company_ledger_entries WHERE transfer_id=10").first()).resolves.toMatchObject({ quantity_milliunits: -3000, amount_owed_paise: -300, status: "RETURNED" });
  });

  it("creates signed zero-value opening pending stock without FIFO or physical inventory movement", async () => {
    const result = await new AccountingHandler(env.DB).execute({
      type: "opening_pending.create", userId: 1, companyId: 1, idempotencyKey: "opening-pending-1", requestDigest: "digest-1",
      payload: { companyId: 1, toCompanyId: 2, referenceNumber: "OP-1", date: "2026-01-01", lines: [{ itemId: 4, quantity: "5" }, { itemId: 5, quantity: "-2" }] },
    });
    await expect(env.DB.prepare("SELECT reason,total_fifo_value_paise,from_stock_book_id,to_stock_book_id FROM inter_company_transfers WHERE id=?").bind(result.id).first()).resolves.toMatchObject({ reason: "OPENING_PENDING_STOCK", total_fifo_value_paise: 0, from_stock_book_id: 1, to_stock_book_id: 2 });
    await expect(env.DB.prepare("SELECT item_id,quantity_milliunits,fifo_value_paise FROM transfer_lines WHERE transfer_id=? ORDER BY item_id").bind(result.id).all()).resolves.toMatchObject({ results: [{ item_id: 4, quantity_milliunits: 5000, fifo_value_paise: 0 }, { item_id: 5, quantity_milliunits: -2000, fifo_value_paise: 0 }] });
    await expect(env.DB.prepare("SELECT COUNT(*) count FROM fifo_layers").first()).resolves.toMatchObject({ count: 0 });
    await expect(env.DB.prepare("SELECT COUNT(*) count FROM stock_ledger_entries").first()).resolves.toMatchObject({ count: 0 });
    await expect(env.DB.prepare("SELECT COUNT(*) count FROM inventory_balances").first()).resolves.toMatchObject({ count: 0 });
    await expect(env.DB.prepare("SELECT company_id,entity_type FROM audit_logs WHERE entity_id=?").bind(String(result.id)).first()).resolves.toMatchObject({ company_id: 1, entity_type: "OpeningPendingStock" });
  });

  it("ignores negative opening snapshot rows when reconstructing legacy pending-return lots", async () => {
    const handler = new AccountingHandler(env.DB);
    await handler.execute({
      type: "opening_pending.create", userId: 1, companyId: 1, idempotencyKey: "opening-positive", requestDigest: "positive",
      payload: { companyId: 1, toCompanyId: 2, referenceNumber: "OP-POS", date: "2026-01-01", lines: [{ itemId: 4, quantity: "5" }] },
    });
    await handler.execute({
      type: "opening_pending.create", userId: 1, companyId: 1, idempotencyKey: "opening-negative", requestDigest: "negative",
      payload: { companyId: 1, toCompanyId: 2, referenceNumber: "OP-NEG", date: "2026-01-02", lines: [{ itemId: 4, quantity: "-2" }] },
    });
    const returned = await handler.execute({
      type: "transfer.create", userId: 1, companyId: 2, idempotencyKey: "legacy-opening-return", requestDigest: "return-four",
      payload: { companyId: 2, stockBookId: 2, toCompanyId: 1, toStockBookId: 1, referenceNumber: "RET-4", date: "2026-01-03", lines: [{ itemId: 4, quantity: "4", rate: "0" }] },
    });
    await expect(env.DB.prepare("SELECT quantity_milliunits,status FROM inter_company_ledger_entries WHERE transfer_id=?").bind(returned.id).first()).resolves.toMatchObject({ quantity_milliunits: -4000, status: "RETURNED" });
    await expect(env.DB.prepare("SELECT original_quantity_milliunits,available_quantity_milliunits FROM fifo_layers WHERE source_type='TRANSFER_RETURN' AND source_id=?").bind(returned.id).first()).resolves.toMatchObject({ original_quantity_milliunits: 4000, available_quantity_milliunits: 4000 });

    const edit = await planTransferEdit(env.DB, {
      id: returned.id, companyId: 2, stockBookId: 2, toCompanyId: 1, toStockBookId: 1,
      referenceNumber: "RET-5", date: "2026-01-04", lines: [{ itemId: 4, quantity: "5", rate: "0" }],
    }, 1);
    await env.DB.batch(prepared(env.DB, edit.mutations));
    await expect(env.DB.prepare("SELECT quantity_milliunits,status FROM inter_company_ledger_entries WHERE transfer_id=?").bind(returned.id).first()).resolves.toMatchObject({ quantity_milliunits: -5000, status: "RETURNED" });
  });
});
