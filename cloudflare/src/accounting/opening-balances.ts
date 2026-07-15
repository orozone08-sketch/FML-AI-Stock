import { money, paymentStatus, type Money } from "../domain";
import { dbInt, nextIds, sql, type SqlMutation } from "./sql";
import {
  assertActiveBook,
  assertActiveCompany,
  assertActiveCustomer,
  assertActivePaymentMode,
  assertActiveSupplier,
} from "./domain-validation";

type Row = Record<string, unknown>;
export type OpeningBalanceKind =
  "receivable" | "payable" | "advance-received" | "advance-paid";
export type OpeningBalanceCommand = {
  id?: number;
  kind: OpeningBalanceKind;
  companyId: number;
  stockBookId?: number;
  partyId: number;
  referenceNumber?: string;
  date: string;
  dueDate?: string;
  transactionType?: string;
  amount: string | number;
  mode?: string;
  remarks?: string;
};
export type MutationPlan = {
  type: "OpeningReceivable" | "OpeningPayable" | "OpeningAdvance" | "Payment";
  id: number;
  status: "created" | "updated" | "deleted";
  mutations: SqlMutation[];
  before?: Row;
};

const now = () => new Date().toISOString();
const isAdvance = (kind: OpeningBalanceKind) => kind.startsWith("advance-");
async function activeBook(
  db: D1Database,
  companyId: number,
  requested?: number,
): Promise<number> {
  if (requested) {
    await assertActiveBook(db, companyId, requested);
    return requested;
  }
  const row = await db
    .prepare(
      "SELECT id FROM stock_books WHERE company_id=? AND active=1 ORDER BY id LIMIT 1",
    )
    .bind(companyId)
    .first<Row>();
  if (!row) throw new Error("The company has no active stock book.");
  return Number(row.id);
}
const openingMeta = (kind: OpeningBalanceKind) =>
  kind === "receivable"
    ? {
        table: "receivables",
        party: "customer_id",
        source: "OPENING_RECEIVABLE",
        type: "OpeningReceivable" as const,
      }
    : {
        table: "payables",
        party: "supplier_id",
        source: "OPENING_PAYABLE",
        type: "OpeningPayable" as const,
      };

export async function planCreateOpeningBalance(
  db: D1Database,
  data: OpeningBalanceCommand,
  userId: number,
): Promise<MutationPlan> {
  const amount = money(data.amount);
  if (amount <= 0n)
    throw new Error("Opening amount must be greater than zero.");
  const t = now();
  await assertActiveCompany(db, data.companyId);
  if (isAdvance(data.kind)) {
    const received = data.kind === "advance-received";
    if (received) await assertActiveCustomer(db, data.partyId);
    else await assertActiveSupplier(db, data.partyId);
    await assertActivePaymentMode(db, data.mode ?? "CASH");
    const ids = await nextIds(db, ["payments"]),
      id = ids.payments;
    return {
      type: "OpeningAdvance",
      id,
      status: "created",
      mutations: [
        sql(
          "INSERT INTO payments(id,company_id,payment_type,party_type,customer_id,supplier_id,payment_date,mode,reference_number,total_amount_paise,allocated_amount_paise,unallocated_amount_paise,remarks,created_at,updated_at,created_by_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          id,
          data.companyId,
          received ? "OPENING_ADVANCE_RECEIVED" : "OPENING_ADVANCE_PAID",
          received ? "CUSTOMER" : "SUPPLIER",
          received ? data.partyId : null,
          received ? null : data.partyId,
          data.date,
          data.mode ?? "CASH",
          data.referenceNumber ?? null,
          dbInt(amount),
          0,
          dbInt(amount),
          data.remarks ?? null,
          t,
          t,
          userId,
        ),
      ],
    };
  }
  if (data.kind === "receivable") await assertActiveCustomer(db, data.partyId);
  else await assertActiveSupplier(db, data.partyId);
  const stockBookId = await activeBook(db, data.companyId, data.stockBookId);
  const meta = openingMeta(data.kind),
    ids = await nextIds(db, [meta.table as "receivables" | "payables"]),
    id = ids[meta.table as "receivables" | "payables"];
  const reference =
    data.referenceNumber?.trim() ||
    `${meta.source === "OPENING_RECEIVABLE" ? "OPN-REC" : "OPN-PAY"}-${id}`;
  return {
    type: meta.type,
    id,
    status: "created",
    mutations: [
      sql(
        `INSERT INTO ${meta.table}(id,company_id,stock_book_id,${meta.party},source_type,source_id,document_number,document_date,due_date,transaction_type,total_amount_paise,paid_amount_paise,balance_amount_paise,payment_status,remarks,is_opening,created_at,updated_at,created_by_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        data.companyId,
        stockBookId,
        data.partyId,
        meta.source,
        id,
        reference,
        data.date,
        data.dueDate ?? null,
        data.transactionType ?? "GST",
        dbInt(amount),
        0,
        dbInt(amount),
        "UNPAID",
        data.remarks ?? null,
        1,
        t,
        t,
        userId,
      ),
    ],
  };
}

export async function planUpdateOpeningBalance(
  db: D1Database,
  data: OpeningBalanceCommand & { id: number },
  userId: number,
): Promise<MutationPlan> {
  const amount = money(data.amount);
  if (amount <= 0n)
    throw new Error("Opening amount must be greater than zero.");
  const t = now();
  if (isAdvance(data.kind)) {
    const row = await db
      .prepare("SELECT * FROM payments WHERE id=?")
      .bind(data.id)
      .first<Row>();
    if (!row || !String(row.payment_type).startsWith("OPENING_ADVANCE"))
      throw new Error("Opening advance was not found.");
    if (BigInt(row.allocated_amount_paise as number) > 0n)
      throw new Error("Opening advance cannot be edited after allocation.");
    const received = row.payment_type === "OPENING_ADVANCE_RECEIVED";
    await assertActiveCompany(db, data.companyId);
    if (received) await assertActiveCustomer(db, data.partyId);
    else await assertActiveSupplier(db, data.partyId);
    await assertActivePaymentMode(db, data.mode ?? String(row.mode ?? "CASH"));
    return {
      type: "OpeningAdvance",
      id: data.id,
      status: "updated",
      before: row,
      mutations: [
        sql(
          "UPDATE payments SET company_id=?,customer_id=?,supplier_id=?,payment_date=?,mode=?,reference_number=?,total_amount_paise=?,allocated_amount_paise=0,unallocated_amount_paise=?,remarks=?,updated_at=?,updated_by_id=? WHERE id=?",
          data.companyId,
          received ? data.partyId : null,
          received ? null : data.partyId,
          data.date,
          data.mode ?? String(row.mode ?? "CASH"),
          data.referenceNumber ?? null,
          dbInt(amount),
          dbInt(amount),
          data.remarks ?? null,
          t,
          userId,
          data.id,
        ),
      ],
    };
  }
  const meta = openingMeta(data.kind),
    row = await db
      .prepare(`SELECT * FROM ${meta.table} WHERE id=?`)
      .bind(data.id)
      .first<Row>();
  if (!row || Number(row.is_opening) !== 1 || row.source_type !== meta.source)
    throw new Error(
      `${meta.type.replace("Opening", "Opening ")} was not found.`,
    );
  const paid = BigInt(row.paid_amount_paise as number);
  if (paid > amount)
    throw new Error(
      `Opening ${data.kind} amount cannot be less than already ${data.kind === "receivable" ? "received" : "paid"} amount.`,
    );
  if (
    paid > 0n &&
    (Number(row.company_id) !== data.companyId ||
      Number(row[meta.party]) !== data.partyId)
  )
    throw new Error(
      `Opening ${data.kind} company or party cannot be changed after allocation.`,
    );
  await assertActiveCompany(db, data.companyId);
  if (data.kind === "receivable") await assertActiveCustomer(db, data.partyId);
  else await assertActiveSupplier(db, data.partyId);
  const stockBookId = await activeBook(db, data.companyId, data.stockBookId);
  const balance = (amount - paid) as Money;
  return {
    type: meta.type,
    id: data.id,
    status: "updated",
    before: row,
    mutations: [
      sql(
        `UPDATE ${meta.table} SET company_id=?,stock_book_id=?,${meta.party}=?,document_number=?,document_date=?,due_date=?,transaction_type=?,total_amount_paise=?,balance_amount_paise=?,payment_status=?,remarks=?,updated_at=?,updated_by_id=? WHERE id=?`,
        data.companyId,
        stockBookId,
        data.partyId,
        data.referenceNumber?.trim() || row.document_number,
        data.date,
        data.dueDate ?? null,
        data.transactionType ?? row.transaction_type,
        dbInt(amount),
        dbInt(balance),
        paymentStatus(amount, paid as Money),
        data.remarks ?? null,
        t,
        userId,
        data.id,
      ),
    ],
  };
}

export async function planDeleteOpeningBalance(
  db: D1Database,
  kind: OpeningBalanceKind,
  id: number,
): Promise<MutationPlan> {
  if (isAdvance(kind)) {
    const row = await db
      .prepare("SELECT * FROM payments WHERE id=?")
      .bind(id)
      .first<Row>();
    if (!row || !String(row.payment_type).startsWith("OPENING_ADVANCE"))
      throw new Error("Opening advance was not found.");
    if (BigInt(row.allocated_amount_paise as number) > 0n)
      throw new Error("Opening advance cannot be deleted after allocation.");
    return {
      type: "OpeningAdvance",
      id,
      status: "deleted",
      before: row,
      mutations: [
        sql("DELETE FROM payment_allocations WHERE payment_id=?", id),
        sql("DELETE FROM payments WHERE id=?", id),
      ],
    };
  }
  const meta = openingMeta(kind),
    row = await db
      .prepare(`SELECT * FROM ${meta.table} WHERE id=?`)
      .bind(id)
      .first<Row>();
  if (!row || Number(row.is_opening) !== 1 || row.source_type !== meta.source)
    throw new Error(`Opening ${kind} was not found.`);
  if (BigInt(row.paid_amount_paise as number) > 0n)
    throw new Error(`Opening ${kind} cannot be deleted after allocation.`);
  return {
    type: meta.type,
    id,
    status: "deleted",
    before: row,
    mutations: [sql(`DELETE FROM ${meta.table} WHERE id=?`, id)],
  };
}
