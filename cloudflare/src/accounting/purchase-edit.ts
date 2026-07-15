import { gstRate, lineTotals, paymentStatus, quantity, rate, type Money } from "../domain";
import { assertDocumentLineCount, assertPurchaseContext } from "./domain-validation";
import { dbInt, sql, type SqlMutation } from "./sql";
import type { PurchaseCommand } from "./types";

type Row = Record<string, number | string | null>;
export type PurchaseEditPlan = { type: "Purchase"; id: number; before: Row; mutations: SqlMutation[] };

const now = () => new Date().toISOString();
const monetaryValue = (q: bigint, r: bigint) => (q * r * 100n + 5_000_000n) / 10_000_000n;
const status = (paid: bigint, total: bigint) => paymentStatus(total as Money, paid as Money);

async function rows(db: D1Database, query: string, ...params: unknown[]): Promise<Row[]> {
  return (await db.prepare(query).bind(...params).all<Row>()).results;
}

function parse(lines: PurchaseCommand["lines"], taxable: boolean) {
  assertDocumentLineCount(lines.length);
  return lines.map((line) => {
    const q = quantity(line.quantity);
    const r = rate(line.rate);
    const g = gstRate(line.gstPercent ?? 0);
    if (q <= 0n) throw new Error("Quantity must be greater than zero.");
    if (r < 0n) throw new Error("Rate cannot be negative.");
    return { ...line, q, r, g, totals: lineTotals(q, r, g, taxable) };
  });
}

function inventorySync(companyId: number, stockBookId: number, itemId: number, timestamp: string): SqlMutation {
  return sql(
    `INSERT INTO inventory_balances(company_id,stock_book_id,item_id,quantity_milliunits,ledger_value_paise,version,updated_at)
     VALUES(?,?,?,
       COALESCE((SELECT SUM(quantity_in_milliunits-quantity_out_milliunits) FROM stock_ledger_entries WHERE company_id=? AND stock_book_id=? AND item_id=?),0),
       COALESCE((SELECT SUM(CASE movement_type WHEN 'IN' THEN value_paise ELSE -value_paise END) FROM stock_ledger_entries WHERE company_id=? AND stock_book_id=? AND item_id=?),0),1,?)
     ON CONFLICT(company_id,stock_book_id,item_id) DO UPDATE SET quantity_milliunits=excluded.quantity_milliunits,ledger_value_paise=excluded.ledger_value_paise,version=inventory_balances.version+1,updated_at=excluded.updated_at`,
    companyId, stockBookId, itemId,
    companyId, stockBookId, itemId,
    companyId, stockBookId, itemId,
    timestamp,
  );
}

function key(companyId: number, stockBookId: number, itemId: number): string {
  return `${companyId}:${stockBookId}:${itemId}`;
}

/**
 * Reconstructs every purchase-derived value in one D1 batch. Reads and validation
 * happen before any mutation is returned, so a rejected edit cannot expose a
 * partially adjusted FIFO, payable, ledger, or inventory balance.
 */
export async function planPurchaseEdit(db: D1Database, data: PurchaseCommand, userId: number): Promise<PurchaseEditPlan> {
  if (!data.id) throw new Error("Document ID is required.");
  const input = parse(data.lines, data.documentType === "GST");
  const old = await db.prepare("SELECT * FROM purchases WHERE id=? AND is_void=0").bind(data.id).first<Row>();
  if (!old) throw new Error("Purchase was not found or is void.");
  if (Number(old.company_id) !== data.companyId) throw new Error("A purchase cannot be moved to another company.");
  await assertPurchaseContext(db, {
    companyId: data.companyId,
    stockBookId: data.stockBookId,
    supplierId: data.supplierId,
    documentType: data.documentType,
    itemIds: input.map((line) => line.itemId),
  });

  const oldLines = await rows(
    db,
    `SELECT pl.*,f.id layer_id,f.original_quantity_milliunits,f.available_quantity_milliunits
       FROM purchase_lines pl
       LEFT JOIN fifo_layers f ON f.source_type='PURCHASE' AND f.source_id=pl.purchase_id AND f.source_line_id=pl.id
      WHERE pl.purchase_id=? ORDER BY pl.id`,
    data.id,
  );
  if (oldLines.length !== input.length) throw new Error("Purchase edits must preserve the existing line count.");
  if (oldLines.some((line) => line.layer_id === null)) throw new Error("Purchase FIFO state is incomplete; repair it before editing this purchase.");

  const remaining = oldLines.map((line, index) => ({ line, index, used: false }));
  const matched = input.map((line) => {
    let match = remaining.find((entry) => !entry.used && Number(entry.line.item_id) === line.itemId);
    if (!match) {
      match = remaining.find((entry) => !entry.used && BigInt(entry.line.original_quantity_milliunits!) === BigInt(entry.line.available_quantity_milliunits!));
    }
    if (!match) throw new Error("A consumed purchase line cannot be changed to another item.");
    match.used = true;
    return { input: line, old: match.line };
  });

  const paid = BigInt(old.paid_amount_paise ?? 0);
  if (paid > 0n && Number(old.supplier_id) !== data.supplierId) throw new Error("Supplier cannot be changed after payment allocation.");

  const purchaseLedgers = await rows(
    db,
    "SELECT id,company_id,stock_book_id,item_id FROM stock_ledger_entries WHERE transaction_type='PURCHASE' AND transaction_id=? ORDER BY id",
    data.id,
  );
  if (purchaseLedgers.length !== oldLines.length) throw new Error("Purchase stock ledger state is incomplete; repair it before editing this purchase.");
  const availableLedgers = purchaseLedgers.map((row) => ({ row, used: false }));

  const timestamp = now();
  const mutations: SqlMutation[] = [];
  const balanceKeys = new Map<string, [number, number, number]>();
  const affectedLayerIds: number[] = [];
  let subtotal = 0n;
  let gst = 0n;
  let total = 0n;

  for (const pair of matched) {
    const line = pair.input;
    const prior = pair.old;
    const original = BigInt(prior.original_quantity_milliunits!);
    const available = BigInt(prior.available_quantity_milliunits!);
    const consumed = original - available;
    if (line.q < consumed) throw new Error("Purchase quantity cannot be reduced below the quantity already consumed.");
    if (consumed > 0n && Number(prior.item_id) !== line.itemId) throw new Error("A consumed purchase line cannot be changed to another item.");
    if (consumed > 0n && Number(old.stock_book_id) !== data.stockBookId) throw new Error("Stock book cannot be changed after purchase stock has been consumed.");

    const ledgerMatch = availableLedgers.find((entry) => !entry.used && Number(entry.row.item_id) === Number(prior.item_id));
    if (!ledgerMatch) throw new Error("Purchase stock ledger line identity is ambiguous; repair it before editing this purchase.");
    ledgerMatch.used = true;

    const layerId = Number(prior.layer_id);
    const newAvailable = line.q - consumed;
    subtotal += line.totals.subtotal;
    gst += line.totals.gst;
    total += line.totals.total;
    affectedLayerIds.push(layerId);

    balanceKeys.set(key(Number(ledgerMatch.row.company_id), Number(ledgerMatch.row.stock_book_id), Number(ledgerMatch.row.item_id)), [Number(ledgerMatch.row.company_id), Number(ledgerMatch.row.stock_book_id), Number(ledgerMatch.row.item_id)]);
    balanceKeys.set(key(data.companyId, data.stockBookId, line.itemId), [data.companyId, data.stockBookId, line.itemId]);

    mutations.push(
      sql(
        "UPDATE purchase_lines SET item_id=?,quantity_milliunits=?,rate_ten_thousandths=?,gst_basis_points=?,subtotal_paise=?,gst_amount_paise=?,line_total_paise=? WHERE id=?",
        line.itemId, dbInt(line.q), dbInt(line.r), dbInt(line.g), dbInt(line.totals.subtotal), dbInt(line.totals.gst), dbInt(line.totals.total), prior.id,
      ),
      sql(
        `UPDATE fifo_layers SET company_id=?,stock_book_id=?,item_id=?,source_reference=?,source_date=?,
          original_quantity_milliunits=?,available_quantity_milliunits=?,unit_cost_ten_thousandths=?,
          original_value_paise=?,available_value_paise=?,status=CASE WHEN ?=0 THEN 'CONSUMED' WHEN ?=? THEN 'OPEN' ELSE 'PARTIAL' END,
          updated_at=?,updated_by_id=? WHERE id=?`,
        data.companyId, data.stockBookId, line.itemId, data.referenceNumber, data.date,
        dbInt(line.q), dbInt(newAvailable), dbInt(line.r), dbInt(monetaryValue(line.q, line.r)), dbInt(monetaryValue(newAvailable, line.r)),
        dbInt(newAvailable), dbInt(newAvailable), dbInt(line.q), timestamp, userId, layerId,
      ),
      sql(
        "UPDATE fifo_consumptions SET rate_ten_thousandths=?,value_paise=CAST((quantity_milliunits*?*100+5000000)/10000000 AS INTEGER) WHERE fifo_layer_id=?",
        dbInt(line.r), dbInt(line.r), layerId,
      ),
      sql(
        `UPDATE stock_ledger_entries SET company_id=?,stock_book_id=?,item_id=?,entry_date=?,reference_number=?,
          quantity_in_milliunits=?,quantity_out_milliunits=0,rate_ten_thousandths=?,value_paise=? WHERE id=?`,
        data.companyId, data.stockBookId, line.itemId, data.date, data.referenceNumber,
        dbInt(line.q), dbInt(line.r), dbInt(line.totals.subtotal), ledgerMatch.row.id,
      ),
    );
  }

  if (paid > total) throw new Error("Purchase total cannot be less than the amount already paid. Edit or delete the payment first.");

  const placeholders = affectedLayerIds.map(() => "?").join(",");
  const changesConsumedCost = matched.some(({ input: line, old: prior }) =>
    BigInt(prior.original_quantity_milliunits!) > BigInt(prior.available_quantity_milliunits!) &&
    line.r !== BigInt(prior.rate_ten_thousandths!),
  );
  const downstreamKeys = await rows(
    db,
    `SELECT DISTINCT s.company_id,s.stock_book_id,s.item_id
       FROM stock_ledger_entries s
      WHERE s.movement_type='OUT' AND s.transaction_type IN('SALE','TRANSFER')
        AND EXISTS(SELECT 1 FROM fifo_consumptions c WHERE c.source_type=s.transaction_type AND c.source_id=s.transaction_id AND c.fifo_layer_id IN(${placeholders}))`,
    ...affectedLayerIds,
  );
  for (const row of downstreamKeys) {
    const triple: [number, number, number] = [Number(row.company_id), Number(row.stock_book_id), Number(row.item_id)];
    balanceKeys.set(key(...triple), triple);
  }

  if (changesConsumedCost) {
    const settled = await db.prepare(
      `SELECT COUNT(*) count FROM inter_company_ledger_entries l
        WHERE l.settled_amount_paise>0 AND EXISTS(
          SELECT 1 FROM fifo_consumptions c WHERE c.source_type='TRANSFER' AND c.source_id=l.transfer_id AND c.fifo_layer_id IN(${placeholders})
        )`,
    ).bind(...affectedLayerIds).first<Row>();
    if (Number(settled?.count ?? 0) > 0) throw new Error("Purchase cost cannot be changed after a derived inter-company amount has been settled.");

    const laterReturn = await db.prepare(
      `SELECT COUNT(*) count
         FROM inter_company_ledger_entries issued
         JOIN inter_company_transfers issue_transfer ON issue_transfer.id=issued.transfer_id
         JOIN fifo_consumptions consumed ON consumed.source_type='TRANSFER' AND consumed.source_id=issued.transfer_id
        WHERE issued.status='PENDING' AND issue_transfer.is_void=0
          AND consumed.fifo_layer_id IN(${placeholders})
          AND EXISTS(
            SELECT 1
              FROM inter_company_ledger_entries returned
              JOIN inter_company_transfers return_transfer ON return_transfer.id=returned.transfer_id
             WHERE returned.status='RETURNED' AND return_transfer.is_void=0
               AND returned.stock_owner_company_id=issued.stock_owner_company_id
               AND returned.stock_user_company_id=issued.stock_user_company_id
               AND returned.item_id=issued.item_id
               AND (return_transfer.transfer_date>issue_transfer.transfer_date
                 OR (return_transfer.transfer_date=issue_transfer.transfer_date AND return_transfer.id>issue_transfer.id))
          )`,
    ).bind(...affectedLayerIds).first<Row>();
    if (Number(laterReturn?.count ?? 0) > 0)
      throw new Error("Purchase cost cannot be changed after stock from it has entered an inter-company return chain.");
  }

  mutations.push(
    sql(
      `UPDATE sale_lines SET
         fifo_cost_paise=(SELECT COALESCE(SUM(value_paise),0) FROM fifo_consumptions WHERE source_type='SALE' AND source_line_id=sale_lines.id),
         gross_profit_paise=subtotal_paise-(SELECT COALESCE(SUM(value_paise),0) FROM fifo_consumptions WHERE source_type='SALE' AND source_line_id=sale_lines.id)
       WHERE id IN(SELECT source_line_id FROM fifo_consumptions WHERE fifo_layer_id IN(${placeholders}) AND source_type='SALE')`,
      ...affectedLayerIds,
    ),
    sql(
      `UPDATE sales SET
         fifo_cost_paise=(SELECT COALESCE(SUM(fifo_cost_paise),0) FROM sale_lines WHERE sale_id=sales.id),
         gross_profit_paise=subtotal_paise-(SELECT COALESCE(SUM(fifo_cost_paise),0) FROM sale_lines WHERE sale_id=sales.id)
       WHERE id IN(SELECT source_id FROM fifo_consumptions WHERE fifo_layer_id IN(${placeholders}) AND source_type='SALE')`,
      ...affectedLayerIds,
    ),
    sql(
      `UPDATE transfer_lines SET fifo_value_paise=(SELECT COALESCE(SUM(value_paise),0) FROM fifo_consumptions WHERE source_type='TRANSFER' AND source_line_id=transfer_lines.id)
       WHERE id IN(SELECT source_line_id FROM fifo_consumptions WHERE fifo_layer_id IN(${placeholders}) AND source_type='TRANSFER')`,
      ...affectedLayerIds,
    ),
    sql(
      `UPDATE inter_company_transfers SET total_fifo_value_paise=(SELECT COALESCE(SUM(fifo_value_paise),0) FROM transfer_lines WHERE transfer_id=inter_company_transfers.id),updated_at=?
       WHERE id IN(SELECT source_id FROM fifo_consumptions WHERE fifo_layer_id IN(${placeholders}) AND source_type='TRANSFER')`,
      timestamp, ...affectedLayerIds,
    ),
    sql(
      `UPDATE inter_company_ledger_entries SET
         amount_owed_paise=CASE WHEN id=(SELECT MIN(l2.id) FROM inter_company_ledger_entries l2 WHERE l2.transfer_id=inter_company_ledger_entries.transfer_id AND l2.item_id=inter_company_ledger_entries.item_id AND l2.status='PENDING')
           THEN (SELECT COALESCE(SUM(fifo_value_paise),0) FROM transfer_lines WHERE transfer_id=inter_company_ledger_entries.transfer_id AND item_id=inter_company_ledger_entries.item_id) ELSE 0 END,
         balance_amount_paise=CASE WHEN id=(SELECT MIN(l2.id) FROM inter_company_ledger_entries l2 WHERE l2.transfer_id=inter_company_ledger_entries.transfer_id AND l2.item_id=inter_company_ledger_entries.item_id AND l2.status='PENDING')
           THEN (SELECT COALESCE(SUM(fifo_value_paise),0) FROM transfer_lines WHERE transfer_id=inter_company_ledger_entries.transfer_id AND item_id=inter_company_ledger_entries.item_id)-settled_amount_paise ELSE 0 END,
         updated_at=?
       WHERE status='PENDING' AND transfer_id IN(SELECT source_id FROM fifo_consumptions WHERE fifo_layer_id IN(${placeholders}) AND source_type='TRANSFER')`,
      timestamp, ...affectedLayerIds,
    ),
    sql(
      `UPDATE stock_ledger_entries SET
         value_paise=CASE WHEN id=(SELECT MIN(s2.id) FROM stock_ledger_entries s2 WHERE s2.transaction_type='SALE' AND s2.transaction_id=stock_ledger_entries.transaction_id AND s2.item_id=stock_ledger_entries.item_id AND s2.movement_type='OUT')
           THEN (SELECT COALESCE(SUM(c.value_paise),0) FROM fifo_consumptions c JOIN sale_lines sl ON sl.id=c.source_line_id WHERE c.source_type='SALE' AND c.source_id=stock_ledger_entries.transaction_id AND sl.item_id=stock_ledger_entries.item_id) ELSE 0 END,
         rate_ten_thousandths=CASE WHEN quantity_out_milliunits=0 OR id<>(SELECT MIN(s2.id) FROM stock_ledger_entries s2 WHERE s2.transaction_type='SALE' AND s2.transaction_id=stock_ledger_entries.transaction_id AND s2.item_id=stock_ledger_entries.item_id AND s2.movement_type='OUT') THEN 0 ELSE
           CAST((SELECT COALESCE(SUM(c.value_paise),0) FROM fifo_consumptions c JOIN sale_lines sl ON sl.id=c.source_line_id WHERE c.source_type='SALE' AND c.source_id=stock_ledger_entries.transaction_id AND sl.item_id=stock_ledger_entries.item_id)*10000000/quantity_out_milliunits/100 AS INTEGER) END
       WHERE transaction_type='SALE' AND movement_type='OUT' AND transaction_id IN(SELECT source_id FROM fifo_consumptions WHERE fifo_layer_id IN(${placeholders}) AND source_type='SALE')`,
      ...affectedLayerIds,
    ),
    sql(
      `UPDATE stock_ledger_entries SET
         value_paise=CASE WHEN id=(SELECT MIN(s2.id) FROM stock_ledger_entries s2 WHERE s2.transaction_type='TRANSFER' AND s2.transaction_id=stock_ledger_entries.transaction_id AND s2.item_id=stock_ledger_entries.item_id AND s2.movement_type='OUT')
           THEN (SELECT COALESCE(SUM(c.value_paise),0) FROM fifo_consumptions c JOIN transfer_lines tl ON tl.id=c.source_line_id WHERE c.source_type='TRANSFER' AND c.source_id=stock_ledger_entries.transaction_id AND tl.item_id=stock_ledger_entries.item_id) ELSE 0 END,
         rate_ten_thousandths=CASE WHEN quantity_out_milliunits=0 OR id<>(SELECT MIN(s2.id) FROM stock_ledger_entries s2 WHERE s2.transaction_type='TRANSFER' AND s2.transaction_id=stock_ledger_entries.transaction_id AND s2.item_id=stock_ledger_entries.item_id AND s2.movement_type='OUT') THEN 0 ELSE
           CAST((SELECT COALESCE(SUM(c.value_paise),0) FROM fifo_consumptions c JOIN transfer_lines tl ON tl.id=c.source_line_id WHERE c.source_type='TRANSFER' AND c.source_id=stock_ledger_entries.transaction_id AND tl.item_id=stock_ledger_entries.item_id)*10000000/quantity_out_milliunits/100 AS INTEGER) END
       WHERE transaction_type='TRANSFER' AND movement_type='OUT' AND transaction_id IN(SELECT source_id FROM fifo_consumptions WHERE fifo_layer_id IN(${placeholders}) AND source_type='TRANSFER')`,
      ...affectedLayerIds,
    ),
    sql(
      `UPDATE purchases SET stock_book_id=?,supplier_id=?,purchase_type=?,bill_number=?,bill_date=?,due_date=?,subtotal_paise=?,gst_total_paise=?,grand_total_paise=?,balance_amount_paise=?,payment_status=?,remarks=?,updated_at=?,updated_by_id=? WHERE id=? AND company_id=?`,
      data.stockBookId, data.supplierId, data.documentType, data.referenceNumber, data.date, data.dueDate ?? null,
      dbInt(subtotal), dbInt(gst), dbInt(total), dbInt(total - paid), status(paid, total), data.remarks ?? null, timestamp, userId, data.id, data.companyId,
    ),
    sql(
      `UPDATE payables SET company_id=?,stock_book_id=?,supplier_id=?,document_number=?,document_date=?,due_date=?,transaction_type=?,total_amount_paise=?,balance_amount_paise=?,payment_status=?,remarks=?,updated_at=?,updated_by_id=? WHERE source_type='PURCHASE' AND source_id=? AND company_id=?`,
      data.companyId, data.stockBookId, data.supplierId, data.referenceNumber, data.date, data.dueDate ?? null, data.documentType,
      dbInt(total), dbInt(total - paid), status(paid, total), data.remarks ?? null, timestamp, userId, data.id, data.companyId,
    ),
  );

  for (const triple of balanceKeys.values()) mutations.push(inventorySync(...triple, timestamp));
  return { type: "Purchase", id: data.id, before: old, mutations };
}
