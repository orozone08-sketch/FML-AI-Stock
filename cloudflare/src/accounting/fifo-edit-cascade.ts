import {
  allocateFifo,
  gstRate,
  lineTotals,
  paymentStatus,
  quantity,
  rate,
  type Money,
} from "../domain";
import type { PurchaseCommand, SaleCommand } from "./types";
import { dbInt, nextIds, sql, type SqlMutation } from "./sql";
import { assertDocumentLineCount, assertSaleContext } from "./domain-validation";
type Row = Record<string, number | string | null>;
export type EditPlan = {
  type: "Purchase" | "Sale";
  id: number;
  before: Row;
  mutations: SqlMutation[];
};
const ts = () => new Date().toISOString(),
  value = (q: bigint, r: bigint) => (q * r * 100n + 5_000_000n) / 10_000_000n;
const balance = (
  company: number,
  book: number,
  item: number,
  q: bigint,
  v: bigint,
  t: string,
) =>
  sql(
    "INSERT INTO inventory_balances(company_id,stock_book_id,item_id,quantity_milliunits,ledger_value_paise,version,updated_at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(company_id,stock_book_id,item_id) DO UPDATE SET quantity_milliunits=quantity_milliunits+excluded.quantity_milliunits,ledger_value_paise=ledger_value_paise+excluded.ledger_value_paise,version=version+1,updated_at=excluded.updated_at",
    company,
    book,
    item,
    dbInt(q),
    dbInt(v),
    t,
  );
const pstatus = (paid: bigint, total: bigint) =>
  paymentStatus(total as Money, paid as Money);
async function rows(db: D1Database, q: string, ...p: unknown[]) {
  return (
    await db
      .prepare(q)
      .bind(...p)
      .all<Row>()
  ).results;
}
function parse(lines: PurchaseCommand["lines"], taxable: boolean) {
  assertDocumentLineCount(lines.length);
  const parsed = lines.map((x) => {
    const q = quantity(x.quantity),
      r = rate(x.rate),
      g = gstRate(x.gstPercent ?? 0);
    if (q <= 0n) throw new Error("Quantity must be greater than zero.");
    if (r < 0n) throw new Error("Rate cannot be negative.");
    return { ...x, q, r, g, t: lineTotals(q, r, g, taxable) };
  });
  if (new Set(parsed.map((line) => line.itemId)).size !== parsed.length)
    throw new Error("A sale may contain each item only once.");
  return parsed;
}

/** Pure planning phase: all reads and validation precede the caller's one atomic D1 batch. */
export async function planSaleEdit(
  db: D1Database,
  data: SaleCommand,
  userId: number,
): Promise<EditPlan> {
  if (!data.id) throw new Error("Document ID is required.");
  const old = await db
    .prepare("SELECT * FROM sales WHERE id=? AND is_void=0")
    .bind(data.id)
    .first<Row>();
  if (!old) throw new Error("Sale was not found or is void.");
  const paid = BigInt(old.paid_amount_paise ?? 0);
  if (paid > 0n && Number(old.customer_id) !== data.customerId)
    throw new Error("Customer cannot be changed after receipt allocation.");
  const input = parse(data.lines, data.documentType === "GST"),
    t = ts(),
    prior = await rows(
      db,
      "SELECT fifo_layer_id,quantity_milliunits,value_paise FROM fifo_consumptions WHERE source_type='SALE' AND source_id=? ORDER BY id",
      data.id,
    ),
    oldLedger = await rows(
      db,
      "SELECT company_id,stock_book_id,item_id,quantity_out_milliunits,value_paise FROM stock_ledger_entries WHERE transaction_type='SALE' AND transaction_id=?",
      data.id,
    ),
    restored = new Map<number, bigint>();
  for (const c of prior)
    restored.set(
      Number(c.fifo_layer_id),
      (restored.get(Number(c.fifo_layer_id)) ?? 0n) +
        BigInt(c.quantity_milliunits!),
    );
  await assertSaleContext(db, {
    companyId: data.companyId,
    stockBookId: data.stockBookId,
    customerId: data.customerId,
    documentType: data.documentType,
    itemIds: input.map((line) => line.itemId),
  });
  const ids = await nextIds(db, [
      "sale_lines",
      "fifo_consumptions",
      "stock_ledger_entries",
    ]),
    m: SqlMutation[] = [
      sql(
        "DELETE FROM fifo_consumptions WHERE source_type='SALE' AND source_id=?",
        data.id,
      ),
      sql(
        "DELETE FROM stock_ledger_entries WHERE transaction_type='SALE' AND transaction_id=?",
        data.id,
      ),
      sql("DELETE FROM sale_lines WHERE sale_id=?", data.id),
    ];
  let sub = 0n,
    gst = 0n,
    total = 0n,
    cost = 0n,
    ci = 0;
  for (const [id, q] of restored)
    m.push(
      sql(
        "UPDATE fifo_layers SET available_quantity_milliunits=available_quantity_milliunits+?,available_value_paise=CAST(((available_quantity_milliunits+?)*unit_cost_ten_thousandths*100+5000000)/10000000 AS INTEGER),status=CASE WHEN available_quantity_milliunits+?=original_quantity_milliunits THEN 'OPEN' ELSE 'PARTIAL' END,updated_at=? WHERE id=?",
        dbInt(q),
        dbInt(q),
        dbInt(q),
        t,
        id,
      ),
    );
  for (const row of oldLedger)
    m.push(
      balance(
        Number(row.company_id),
        Number(row.stock_book_id),
        Number(row.item_id),
        BigInt(row.quantity_out_milliunits!),
        BigInt(row.value_paise!),
        t,
      ),
    );
  for (let i = 0; i < input.length; i++) {
    const l = input[i]!;
    const rr = await rows(
        db,
        "SELECT id,source_date,available_quantity_milliunits,unit_cost_ten_thousandths FROM fifo_layers WHERE company_id=? AND stock_book_id=? AND item_id=? AND (available_quantity_milliunits>0 OR id IN(SELECT fifo_layer_id FROM fifo_consumptions WHERE source_type='SALE' AND source_id=?)) ORDER BY source_date,id",
        data.companyId,
        data.stockBookId,
        l.itemId,
        data.id,
      ),
      layers = rr.map((x) => ({
        id: Number(x.id),
        sourceDate: String(x.source_date),
        availableQuantity: (BigInt(x.available_quantity_milliunits!) +
          (restored.get(Number(x.id)) ?? 0n)) as any,
        unitCost: BigInt(x.unit_cost_ten_thousandths!) as any,
      })).filter((layer) => layer.availableQuantity > 0n),
      a = allocateFifo(l.q, layers);
    const lid = ids.sale_lines + i;
    sub += l.t.subtotal;
    gst += l.t.gst;
    total += l.t.total;
    cost += a.coveredCost;
    m.push(
      sql(
        "INSERT INTO sale_lines(id,sale_id,item_id,quantity_milliunits,sale_rate_ten_thousandths,gst_basis_points,subtotal_paise,gst_amount_paise,line_total_paise,fifo_cost_paise,gross_profit_paise) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        lid,
        data.id,
        l.itemId,
        dbInt(l.q),
        dbInt(l.r),
        dbInt(l.g),
        dbInt(l.t.subtotal),
        dbInt(l.t.gst),
        dbInt(l.t.total),
        dbInt(a.coveredCost),
        dbInt(l.t.subtotal - a.coveredCost),
      ),
    );
    for (const c of a.consumptions) {
      if (c.layerId === null) continue;
      const z = a.layers.find((x) => x.id === c.layerId)!;
      m.push(
        sql(
          "UPDATE fifo_layers SET available_quantity_milliunits=?,available_value_paise=?,status=CASE WHEN ?=0 THEN 'CONSUMED' ELSE 'PARTIAL' END,updated_at=? WHERE id=?",
          dbInt(z.availableQuantity),
          dbInt(value(z.availableQuantity, z.unitCost)),
          dbInt(z.availableQuantity),
          t,
          c.layerId,
        ),
        sql(
          "INSERT INTO fifo_consumptions(id,fifo_layer_id,source_type,source_id,source_line_id,quantity_milliunits,rate_ten_thousandths,value_paise,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          ids.fifo_consumptions + ci++,
          c.layerId,
          "SALE",
          data.id,
          lid,
          dbInt(c.quantity),
          dbInt(c.rate),
          dbInt(c.value),
          t,
        ),
      );
    }
    const avg = (a.coveredCost * 10_000_000n) / l.q / 100n;
    m.push(
      sql(
        "INSERT INTO stock_ledger_entries(id,company_id,stock_book_id,item_id,entry_date,movement_type,transaction_type,transaction_id,reference_number,quantity_in_milliunits,quantity_out_milliunits,rate_ten_thousandths,value_paise,created_at,created_by_id) VALUES(?,?,?,?,?,'OUT','SALE',?,?,0,?,?,?,?,?)",
        ids.stock_ledger_entries + i,
        data.companyId,
        data.stockBookId,
        l.itemId,
        data.date,
        data.id,
        data.referenceNumber,
        dbInt(l.q),
        dbInt(avg),
        dbInt(a.coveredCost),
        t,
        userId,
      ),
      balance(
        data.companyId,
        data.stockBookId,
        l.itemId,
        -l.q,
        -a.coveredCost,
        t,
      ),
    );
  }
  if (paid > total)
    throw new Error(
      "Sale total cannot be less than the amount already received. Edit or delete the receipt first.",
    );
  m.push(
    sql(
      "UPDATE sales SET stock_book_id=?,customer_id=?,sale_type=?,invoice_number=?,invoice_date=?,due_date=?,subtotal_paise=?,gst_total_paise=?,grand_total_paise=?,fifo_cost_paise=?,gross_profit_paise=?,balance_amount_paise=?,payment_status=?,remarks=?,updated_at=?,updated_by_id=? WHERE id=?",
      data.stockBookId,
      data.customerId,
      data.documentType,
      data.referenceNumber,
      data.date,
      data.dueDate ?? null,
      dbInt(sub),
      dbInt(gst),
      dbInt(total),
      dbInt(cost),
      dbInt(sub - cost),
      dbInt(total - paid),
      pstatus(paid, total),
      data.remarks ?? null,
      t,
      userId,
      data.id,
    ),
    sql(
      "UPDATE receivables SET stock_book_id=?,customer_id=?,document_number=?,document_date=?,due_date=?,transaction_type=?,total_amount_paise=?,balance_amount_paise=?,payment_status=?,remarks=?,updated_at=?,updated_by_id=? WHERE source_type='SALE' AND source_id=?",
      data.stockBookId,
      data.customerId,
      data.referenceNumber,
      data.date,
      data.dueDate ?? null,
      data.documentType,
      dbInt(total),
      dbInt(total - paid),
      pstatus(paid, total),
      data.remarks ?? null,
      t,
      userId,
      data.id,
    ),
  );
  return { type: "Sale", id: data.id, before: old, mutations: m };
}

export { planPurchaseEdit } from "./purchase-edit";
