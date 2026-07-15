import { allocateFifo, quantity, rate } from "../domain";
import { assertDocumentLineCount, assertTransferContext } from "./domain-validation";
import { dbInt, nextIds, sql, type SqlMutation } from "./sql";
import type { TransferCommand } from "./types";

type Row = Record<string, number | string | null>;
export type TransferEditPlan = { type: "InterCompanyTransfer"; id: number; before: Row; mutations: SqlMutation[] };

const now = () => new Date().toISOString();
const valueAt = (q: bigint, r: bigint) => (q * r * 100n + 5_000_000n) / 10_000_000n;

async function rows(db: D1Database, query: string, ...params: unknown[]): Promise<Row[]> {
  return (await db.prepare(query).bind(...params).all<Row>()).results;
}

function parse(lines: TransferCommand["lines"]) {
  assertDocumentLineCount(lines.length);
  const parsed = lines.map((line) => {
    const q = quantity(line.quantity);
    const r = rate(line.rate);
    if (q <= 0n) throw new Error("Quantity must be greater than zero.");
    if (r < 0n) throw new Error("Rate cannot be negative.");
    return { ...line, q, r };
  });
  if (new Set(parsed.map((line) => line.itemId)).size !== parsed.length) throw new Error("A transfer may contain each item only once.");
  return parsed;
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

function ledger(
  id: number,
  data: { companyId: number; stockBookId: number; referenceNumber: string; date: string },
  itemId: number,
  movement: "IN" | "OUT",
  transferId: number,
  q: bigint,
  r: bigint,
  value: bigint,
  userId: number,
  timestamp: string,
): SqlMutation {
  return sql(
    "INSERT INTO stock_ledger_entries(id,company_id,stock_book_id,item_id,entry_date,movement_type,transaction_type,transaction_id,reference_number,quantity_in_milliunits,quantity_out_milliunits,rate_ten_thousandths,value_paise,created_at,created_by_id) VALUES(?,?,?,?,?,?,'TRANSFER',?,?,?,?,?,?,?,?)",
    id, data.companyId, data.stockBookId, itemId, data.date, movement, transferId, data.referenceNumber,
    movement === "IN" ? dbInt(q) : 0, movement === "OUT" ? dbInt(q) : 0, dbInt(r), dbInt(value), timestamp, userId,
  );
}

function layer(
  id: number,
  data: { companyId: number; stockBookId: number; referenceNumber: string; date: string },
  itemId: number,
  lineId: number,
  q: bigint,
  r: bigint,
  value: bigint,
  transferId: number,
  userId: number,
  timestamp: string,
): SqlMutation {
  return sql(
    "INSERT INTO fifo_layers(id,company_id,stock_book_id,item_id,source_type,source_id,source_line_id,source_reference,source_date,original_quantity_milliunits,available_quantity_milliunits,unit_cost_ten_thousandths,original_value_paise,available_value_paise,status,created_at,updated_at,created_by_id) VALUES(?,?,?,?,'TRANSFER_RETURN',?,?,?,?,?,?,?,?,?,'OPEN',?,?,?)",
    id, data.companyId, data.stockBookId, itemId, transferId, lineId, data.referenceNumber, data.date,
    dbInt(q), dbInt(q), dbInt(r), dbInt(value), dbInt(value), timestamp, timestamp, userId,
  );
}

function addKey(keys: Map<string, [number, number, number]>, company: number, book: number, item: number): void {
  keys.set(`${company}:${book}:${item}`, [company, book, item]);
}

function pendingLots(entries: Row[]): Row[] {
  const lots: Row[] = [];
  for (const entry of entries) {
    let q = BigInt(entry.quantity_milliunits!);
    if (entry.reason === "OPENING_PENDING_STOCK" && q <= 0n) continue;
    if (q > 0n) {
      lots.push({ ...entry });
      continue;
    }
    let returned = -q;
    for (const lot of lots) {
      if (returned <= 0n) break;
      const available = BigInt(lot.quantity_milliunits!);
      const take = available < returned ? available : returned;
      const amount = BigInt(lot.amount_owed_paise!);
      const remainder = available - take;
      lot.quantity_milliunits = Number(remainder);
      lot.amount_owed_paise = Number(available === 0n ? 0n : (amount * remainder + available / 2n) / available);
      returned -= take;
    }
  }
  return lots.filter((lot) => BigInt(lot.quantity_milliunits!) > 0n);
}

/** Reverses the old transfer and rebuilds its submitted lines and all derived state atomically. */
export async function planTransferEdit(db: D1Database, data: TransferCommand, userId: number): Promise<TransferEditPlan> {
  if (!data.id) throw new Error("Document ID is required.");
  const input = parse(data.lines);
  const old = await db.prepare("SELECT * FROM inter_company_transfers WHERE id=? AND is_void=0").bind(data.id).first<Row>();
  if (!old) throw new Error("Transfer was not found or is void.");
  if (Number(old.from_company_id) !== data.companyId || Number(old.to_company_id) !== data.toCompanyId) {
    throw new Error("Transfer companies cannot be changed after stock movement.");
  }
  await assertTransferContext(db, {
    companyId: data.companyId,
    stockBookId: data.stockBookId,
    toCompanyId: data.toCompanyId,
    toStockBookId: data.toStockBookId,
    mismatchApproved: Boolean(data.mismatchApproved),
    itemIds: input.map((line) => line.itemId),
  });

  const oldLines = await rows(db, "SELECT * FROM transfer_lines WHERE transfer_id=? ORDER BY id", data.id);
  const oldEntries = await rows(db, "SELECT * FROM inter_company_ledger_entries WHERE transfer_id=? ORDER BY id", data.id);
  const oldLedgers = await rows(db, "SELECT * FROM stock_ledger_entries WHERE transaction_type='TRANSFER' AND transaction_id=? ORDER BY id", data.id);
  if (!oldLines.length || !oldEntries.length || !oldLedgers.length) throw new Error("Transfer accounting state is incomplete; repair it before editing this transfer.");
  const statuses = new Set(oldEntries.map((entry) => String(entry.status)));
  if (statuses.size !== 1 || !["PENDING", "RETURNED"].includes([...statuses][0]!)) throw new Error("Transfer direction is ambiguous; repair it before editing this transfer.");
  const direction = [...statuses][0] === "PENDING" ? "ISSUE" : "RETURN";
  if (oldEntries.some((entry) => BigInt(entry.settled_amount_paise ?? 0) > 0n)) {
    throw new Error("Transfer cannot be edited after its inter-company amount has been settled.");
  }

  const timestamp = now();
  const ids = await nextIds(db, ["transfer_lines", "fifo_consumptions", "stock_ledger_entries", "fifo_layers", "inter_company_ledger_entries"]);
  const mutations: SqlMutation[] = [];
  const balanceKeys = new Map<string, [number, number, number]>();
  for (const row of oldLedgers) addKey(balanceKeys, Number(row.company_id), Number(row.stock_book_id), Number(row.item_id));

  const priorConsumptions = await rows(db, "SELECT fifo_layer_id,quantity_milliunits,value_paise FROM fifo_consumptions WHERE source_type='TRANSFER' AND source_id=? ORDER BY id", data.id);
  const restored = new Map<number, bigint>();
  for (const consumption of priorConsumptions) {
    const layerId = Number(consumption.fifo_layer_id);
    const q = BigInt(consumption.quantity_milliunits!);
    restored.set(layerId, (restored.get(layerId) ?? 0n) + q);
    mutations.push(sql(
      "UPDATE fifo_layers SET available_quantity_milliunits=available_quantity_milliunits+?,available_value_paise=available_value_paise+?,status=CASE WHEN available_quantity_milliunits+?=original_quantity_milliunits THEN 'OPEN' ELSE 'PARTIAL' END,updated_at=? WHERE id=?",
      dbInt(q), consumption.value_paise, dbInt(q), timestamp, layerId,
    ));
  }

  if (direction === "ISSUE") {
    const itemIds = oldLines.map((line) => Number(line.item_id));
    const placeholders = itemIds.map(() => "?").join(",");
    const laterReturn = await db.prepare(
      `SELECT COUNT(*) count FROM inter_company_ledger_entries r
        JOIN inter_company_transfers t ON t.id=r.transfer_id
       WHERE r.status='RETURNED' AND r.stock_owner_company_id=? AND r.stock_user_company_id=?
         AND r.item_id IN(${placeholders}) AND t.is_void=0
         AND (t.transfer_date>? OR (t.transfer_date=? AND t.id>?))`,
    ).bind(data.companyId, data.toCompanyId, ...itemIds, old.transfer_date, old.transfer_date, data.id).first<Row>();
    if (Number(laterReturn?.count ?? 0) > 0) throw new Error("Transfer cannot be edited after stock has been returned against it.");
  } else {
    const returnLayers = await rows(db, "SELECT id,original_quantity_milliunits,available_quantity_milliunits FROM fifo_layers WHERE source_type='TRANSFER_RETURN' AND source_id=?", data.id);
    if (returnLayers.some((row) => BigInt(row.original_quantity_milliunits!) !== BigInt(row.available_quantity_milliunits!))) {
      throw new Error("Return cannot be edited after returned stock has been consumed.");
    }
  }

  mutations.push(
    sql("DELETE FROM fifo_consumptions WHERE source_type='TRANSFER' AND source_id=?", data.id),
    sql("DELETE FROM fifo_layers WHERE source_type='TRANSFER_RETURN' AND source_id=?", data.id),
    sql("DELETE FROM stock_ledger_entries WHERE transaction_type='TRANSFER' AND transaction_id=?", data.id),
    sql("DELETE FROM inter_company_ledger_entries WHERE transfer_id=?", data.id),
    sql("DELETE FROM transfer_lines WHERE transfer_id=?", data.id),
  );

  let total = 0n;
  let lineIndex = 0;
  let consumptionIndex = 0;
  let ledgerIndex = 0;
  let layerIndex = 0;

  for (const line of input) {
    const lineId = ids.transfer_lines + lineIndex;
    let lineValue = 0n;

    if (direction === "ISSUE") {
      const fifoRows = await rows(
        db,
        "SELECT id,source_date,available_quantity_milliunits,unit_cost_ten_thousandths FROM fifo_layers WHERE company_id=? AND stock_book_id=? AND item_id=? ORDER BY source_date,id",
        data.companyId, data.stockBookId, line.itemId,
      );
      const fifo = fifoRows
        .map((row) => ({
          id: Number(row.id),
          sourceDate: String(row.source_date),
          availableQuantity: (BigInt(row.available_quantity_milliunits!) + (restored.get(Number(row.id)) ?? 0n)) as ReturnType<typeof quantity>,
          unitCost: BigInt(row.unit_cost_ten_thousandths!) as ReturnType<typeof rate>,
        }))
        .filter((layerRow) => layerRow.availableQuantity > 0n);
      const allocation = allocateFifo(line.q, fifo);
      lineValue = allocation.coveredCost;
      for (const consumption of allocation.consumptions) {
        mutations.push(ledger(
          ids.stock_ledger_entries + ledgerIndex++,
          data,
          line.itemId,
          "OUT",
          data.id,
          consumption.quantity,
          consumption.rate,
          consumption.value,
          userId,
          timestamp,
        ));
        if (consumption.layerId !== null) {
          const resulting = allocation.layers.find((candidate) => candidate.id === consumption.layerId)!;
          mutations.push(
            sql(
              "UPDATE fifo_layers SET available_quantity_milliunits=?,available_value_paise=?,status=CASE WHEN ?=0 THEN 'CONSUMED' ELSE 'PARTIAL' END,updated_at=? WHERE id=?",
              dbInt(resulting.availableQuantity), dbInt(valueAt(resulting.availableQuantity, resulting.unitCost)), dbInt(resulting.availableQuantity), timestamp, consumption.layerId,
            ),
            sql(
              "INSERT INTO fifo_consumptions(id,fifo_layer_id,source_type,source_id,source_line_id,quantity_milliunits,rate_ten_thousandths,value_paise,created_at) VALUES(?,?,'TRANSFER',?,?,?,?,?,?)",
              ids.fifo_consumptions + consumptionIndex++, consumption.layerId, data.id, lineId,
              dbInt(consumption.quantity), dbInt(consumption.rate), dbInt(consumption.value), timestamp,
            ),
          );
        }
      }
      addKey(balanceKeys, data.companyId, data.stockBookId, line.itemId);
    } else {
      const history = await rows(
        db,
        `SELECT l.id,l.quantity_milliunits,l.amount_owed_paise,t.reason
           FROM inter_company_ledger_entries l JOIN inter_company_transfers t ON t.id=l.transfer_id
          WHERE l.stock_owner_company_id=? AND l.stock_user_company_id=? AND l.item_id=? AND t.is_void=0 AND l.transfer_id<>?
          ORDER BY t.transfer_date,t.id,l.id`,
        data.toCompanyId, data.companyId, line.itemId, data.id,
      );
      const lots = pendingLots(history);
      const available = lots.reduce((sum, lot) => sum + BigInt(lot.quantity_milliunits!), 0n);
      if (available < line.q) throw new Error(`Cannot return more stock than pending. Pending: ${available}; requested: ${line.q}.`);
      let remaining: bigint = line.q;
      for (const lot of lots) {
        if (remaining <= 0n) break;
        const lotQuantity = BigInt(lot.quantity_milliunits!);
        const take = lotQuantity < remaining ? lotQuantity : remaining;
        const lotValue = BigInt(lot.amount_owed_paise!);
        const movedValue = lotQuantity === 0n ? 0n : (take * lotValue + lotQuantity / 2n) / lotQuantity;
        const unitRate = take === 0n ? 0n : movedValue * 10_000_000n / take / 100n;
        lineValue += movedValue;
        const ownerData = { companyId: data.toCompanyId, stockBookId: data.toStockBookId, referenceNumber: data.referenceNumber, date: data.date };
        mutations.push(
          layer(ids.fifo_layers + layerIndex++, ownerData, line.itemId, lineId, take, unitRate, movedValue, data.id, userId, timestamp),
          ledger(ids.stock_ledger_entries + ledgerIndex++, ownerData, line.itemId, "IN", data.id, take, unitRate, movedValue, userId, timestamp),
        );
        remaining -= take;
      }
      addKey(balanceKeys, data.toCompanyId, data.toStockBookId, line.itemId);
    }

    mutations.push(
      sql("INSERT INTO transfer_lines(id,transfer_id,item_id,quantity_milliunits,fifo_value_paise) VALUES(?,?,?,?,?)", lineId, data.id, line.itemId, dbInt(line.q), dbInt(lineValue)),
      sql(
        "INSERT INTO inter_company_ledger_entries(id,stock_owner_company_id,stock_user_company_id,transfer_id,item_id,quantity_milliunits,amount_owed_paise,settled_amount_paise,balance_amount_paise,status,created_at,updated_at,created_by_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ids.inter_company_ledger_entries + lineIndex,
        direction === "RETURN" ? data.toCompanyId : data.companyId,
        direction === "RETURN" ? data.companyId : data.toCompanyId,
        data.id, line.itemId,
        direction === "RETURN" ? -dbInt(line.q) : dbInt(line.q),
        direction === "RETURN" ? -dbInt(lineValue) : dbInt(lineValue),
        0, direction === "RETURN" ? 0 : dbInt(lineValue), direction === "RETURN" ? "RETURNED" : "PENDING",
        timestamp, timestamp, userId,
      ),
    );
    total += lineValue;
    lineIndex++;
  }

  mutations.push(sql(
    `UPDATE inter_company_transfers SET from_stock_book_id=?,to_stock_book_id=?,reference_number=?,transfer_date=?,reason=?,remarks=?,
       total_fifo_value_paise=?,mismatch_approved=?,approval_reason=?,approved_by_id=?,approved_at=?,updated_at=?,updated_by_id=?
     WHERE id=? AND from_company_id=? AND to_company_id=?`,
    data.stockBookId, data.toStockBookId, data.referenceNumber, data.date, data.reason ?? null, data.remarks ?? null,
    dbInt(total), data.mismatchApproved ? 1 : 0, data.approvalReason ?? null,
    data.mismatchApproved ? userId : null, data.mismatchApproved ? timestamp : null, timestamp, userId,
    data.id, data.companyId, data.toCompanyId,
  ));
  for (const triple of balanceKeys.values()) mutations.push(inventorySync(...triple, timestamp));

  return { type: "InterCompanyTransfer", id: data.id, before: old, mutations };
}
