import { quantity } from "../domain";
import { assertActiveBook, assertActiveCompany, assertActiveItems, assertDocumentLineCount } from "./domain-validation";
import { dbInt, nextIds, sql, type SqlMutation } from "./sql";
import type { OpeningPendingCommand } from "./types";

type Row = Record<string, number | string | null>;
export type OpeningPendingPlan = { type: "OpeningPendingStock"; id: number; before: null; mutations: SqlMutation[] };

async function activeBook(db: D1Database, companyId: number, requested?: number): Promise<number> {
  if (requested !== undefined && Number.isSafeInteger(requested) && requested > 0) {
    await assertActiveBook(db, companyId, requested);
    return requested;
  }
  const row = await db.prepare("SELECT id FROM stock_books WHERE company_id=? AND active=1 ORDER BY id LIMIT 1").bind(companyId).first<Row>();
  if (!row) throw new Error("The selected company has no active stock book.");
  return Number(row.id);
}

/**
 * Opening pending stock establishes only the inter-company custody position. It
 * intentionally does not create FIFO, stock-ledger, or inventory-balance value:
 * no physical movement occurred at migration cut-over and no historical rate is
 * required. Signed quantities are retained exactly, matching the legacy import.
 */
export async function planCreateOpeningPending(
  db: D1Database,
  data: OpeningPendingCommand,
  userId: number,
): Promise<OpeningPendingPlan> {
  if (data.companyId === data.toCompanyId) throw new Error("Pending-stock companies must differ.");
  const reference = data.referenceNumber.trim();
  if (!reference) throw new Error("Transfer reference number is required.");
  assertDocumentLineCount(data.lines.length);
  const lines = data.lines.map((line) => {
    const q = quantity(line.quantity);
    if (q === 0n) throw new Error("Quantity cannot be zero.");
    return { itemId: line.itemId, q };
  });
  if (new Set(lines.map((line) => line.itemId)).size !== lines.length) throw new Error("Opening pending stock may contain each item only once.");

  await assertActiveCompany(db, data.companyId);
  await assertActiveCompany(db, data.toCompanyId);
  await assertActiveItems(db, lines.map((line) => line.itemId));
  const fromBookId = await activeBook(db, data.companyId, data.stockBookId);
  const toBookId = await activeBook(db, data.toCompanyId, data.toStockBookId);
  const ids = await nextIds(db, ["inter_company_transfers", "transfer_lines", "inter_company_ledger_entries"]);
  const timestamp = new Date().toISOString();
  const mutations: SqlMutation[] = [sql(
    `INSERT INTO inter_company_transfers(id,from_company_id,from_stock_book_id,to_company_id,to_stock_book_id,reference_number,transfer_date,reason,remarks,total_fifo_value_paise,mismatch_approved,approval_reason,approved_by_id,approved_at,created_at,updated_at,created_by_id)
     VALUES(?,?,?,?,?,?,?,'OPENING_PENDING_STOCK',?,0,1,'Opening pending stock import',?,?,?, ?,?)`,
    ids.inter_company_transfers, data.companyId, fromBookId, data.toCompanyId, toBookId, reference, data.date,
    data.remarks ?? null, userId, timestamp, timestamp, timestamp, userId,
  )];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    mutations.push(
      sql(
        "INSERT INTO transfer_lines(id,transfer_id,item_id,quantity_milliunits,fifo_value_paise) VALUES(?,?,?,?,0)",
        ids.transfer_lines + index, ids.inter_company_transfers, line.itemId, dbInt(line.q),
      ),
      sql(
        `INSERT INTO inter_company_ledger_entries(id,stock_owner_company_id,stock_user_company_id,transfer_id,item_id,quantity_milliunits,amount_owed_paise,settled_amount_paise,balance_amount_paise,status,created_at,updated_at,created_by_id)
         VALUES(?,?,?,?,?,?,0,0,0,'PENDING',?,?,?)`,
        ids.inter_company_ledger_entries + index, data.companyId, data.toCompanyId, ids.inter_company_transfers,
        line.itemId, dbInt(line.q), timestamp, timestamp, userId,
      ),
    );
  }
  return { type: "OpeningPendingStock", id: ids.inter_company_transfers, before: null, mutations };
}
