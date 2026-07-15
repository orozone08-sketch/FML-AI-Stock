import {
  allocatePayment,
  money,
  paymentStatus,
  type Money,
  type Outstanding,
} from "../domain";
import { dbInt, nextIds, sql, type SqlMutation } from "./sql";
import type { PaymentCommand } from "./types";
import type { MutationPlan } from "./opening-balances";
import { assertPaymentContext } from "./domain-validation";
type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const linked = (table: string) =>
  table === "receivables" ? "sales" : "purchases";

function syncMutation(
  table: string,
  row: Outstanding,
  t: string,
): SqlMutation[] {
  const balance = (row.total - row.paid) as Money,
    status = paymentStatus(row.total, row.paid);
  return [
    sql(
      `UPDATE ${table} SET paid_amount_paise=?,balance_amount_paise=?,payment_status=?,updated_at=? WHERE id=?`,
      dbInt(row.paid),
      dbInt(balance),
      status,
      t,
      row.id,
    ),
    sql(
      `UPDATE ${linked(table)} SET paid_amount_paise=?,balance_amount_paise=?,payment_status=?,updated_at=? WHERE id=(SELECT source_id FROM ${table} WHERE id=? AND source_type=?)`,
      dbInt(row.paid),
      dbInt(balance),
      status,
      t,
      row.id,
      table === "receivables" ? "SALE" : "PURCHASE",
    ),
  ];
}

export async function planReconstructPayment(
  db: D1Database,
  data: PaymentCommand & { id: number },
  userId: number,
): Promise<MutationPlan> {
  const old = await db
    .prepare("SELECT * FROM payments WHERE id=?")
    .bind(data.id)
    .first<Row>();
  if (!old) throw new Error("Payment was not found.");
  if (
    !["CUSTOMER_RECEIPT", "SUPPLIER_PAYMENT"].includes(String(old.payment_type))
  )
    throw new Error(
      "Only customer receipts and supplier payments can be edited from Payments.",
    );
  const customer = data.paymentType === "CUSTOMER_RECEIPT",
    table = customer ? "receivables" : "payables",
    party = customer ? "customer_id" : "supplier_id",
    t = now(),
    m: SqlMutation[] = [];
  await assertPaymentContext(db, {
    companyId: data.companyId,
    partyId: data.partyId,
    customer,
    mode: data.mode,
  });
  const prior = await db
    .prepare(
      "SELECT target_type,target_id,amount_paise FROM payment_allocations WHERE payment_id=?",
    )
    .bind(data.id)
    .all<Row>();
  for (const a of prior.results) {
    const targetTable =
        a.target_type === "RECEIVABLE" ? "receivables" : "payables",
      r = await db
        .prepare(
          `SELECT id,total_amount_paise,paid_amount_paise FROM ${targetTable} WHERE id=?`,
        )
        .bind(a.target_id)
        .first<Row>();
    if (r) {
      const paid =
        BigInt(r.paid_amount_paise as number) -
        BigInt(a.amount_paise as number);
      const o = {
        id: Number(r.id),
        companyId: 0,
        partyId: 0,
        documentDate: "",
        dueDate: null,
        total: BigInt(r.total_amount_paise as number) as Money,
        paid: (paid < 0n ? 0n : paid) as Money,
      };
      m.push(...syncMutation(targetTable, o, t));
    }
  }
  m.push(sql("DELETE FROM payment_allocations WHERE payment_id=?", data.id));
  const total = money(data.amount);
  if (total <= 0n) throw new Error("Payment amount must be greater than zero.");
  const rows = await db
    .prepare(
      `SELECT id,company_id,${party} party_id,due_date,document_date,total_amount_paise,paid_amount_paise FROM ${table} WHERE company_id=? AND ${party}=? ORDER BY due_date,document_date,id`,
    )
    .bind(data.companyId, data.partyId)
    .all<Row>();
  const reversed = new Map<number, bigint>();
  for (const a of prior.results) {
    const expected = customer ? "RECEIVABLE" : "PAYABLE";
    if (a.target_type === expected)
      reversed.set(
        Number(a.target_id),
        (reversed.get(Number(a.target_id)) ?? 0n) +
          BigInt(a.amount_paise as number),
      );
  }
  const out: Outstanding[] = rows.results
    .map((r) => {
      const adjusted =
        BigInt(r.paid_amount_paise as number) -
        (reversed.get(Number(r.id)) ?? 0n);
      return {
        id: Number(r.id),
        companyId: Number(r.company_id),
        partyId: Number(r.party_id),
        dueDate: r.due_date as string | null,
        documentDate: String(r.document_date),
        total: BigInt(r.total_amount_paise as number) as Money,
        paid: (adjusted < 0n ? 0n : adjusted) as Money,
      };
    })
    .filter((r) => r.paid < r.total);
  const allocation = allocatePayment(
      total,
      data.companyId,
      data.partyId,
      out,
      data.preferredTargetId,
    ),
    ids = await nextIds(db, ["payment_allocations"]);
  m.push(
    sql(
      "UPDATE payments SET company_id=?,payment_type=?,party_type=?,customer_id=?,supplier_id=?,payment_date=?,mode=?,reference_number=?,total_amount_paise=?,allocated_amount_paise=?,unallocated_amount_paise=?,remarks=?,updated_at=?,updated_by_id=? WHERE id=?",
      data.companyId,
      data.paymentType,
      customer ? "CUSTOMER" : "SUPPLIER",
      customer ? data.partyId : null,
      customer ? null : data.partyId,
      data.date,
      data.mode,
      data.referenceNumber ?? null,
      dbInt(total),
      dbInt(allocation.allocated),
      dbInt(allocation.unallocated),
      data.remarks ?? null,
      t,
      userId,
      data.id,
    ),
  );
  allocation.allocations.forEach((a, i) => {
    const target = allocation.outstandings.find((x) => x.id === a.targetId)!;
    m.push(
      sql(
        "INSERT INTO payment_allocations(id,payment_id,target_type,target_id,amount_paise,created_at) VALUES(?,?,?,?,?,?)",
        ids.payment_allocations + i,
        data.id,
        customer ? "RECEIVABLE" : "PAYABLE",
        a.targetId,
        dbInt(a.amount),
        t,
      ),
      ...syncMutation(table, target, t),
    );
  });
  return {
    type: "Payment",
    id: data.id,
    status: "updated",
    before: old,
    mutations: m,
  };
}

export async function planDeletePayment(
  db: D1Database,
  id: number,
): Promise<MutationPlan> {
  const old = await db
    .prepare("SELECT * FROM payments WHERE id=?")
    .bind(id)
    .first<Row>();
  if (!old) throw new Error("Payment was not found.");
  if (
    !["CUSTOMER_RECEIPT", "SUPPLIER_PAYMENT"].includes(String(old.payment_type))
  )
    throw new Error(
      "Only customer receipts and supplier payments can be deleted from Payments.",
    );
  const rows = await db
      .prepare(
        "SELECT target_type,target_id,amount_paise FROM payment_allocations WHERE payment_id=?",
      )
      .bind(id)
      .all<Row>(),
    t = now(),
    m: SqlMutation[] = [];
  for (const a of rows.results) {
    const table = a.target_type === "RECEIVABLE" ? "receivables" : "payables",
      r = await db
        .prepare(
          `SELECT id,total_amount_paise,paid_amount_paise FROM ${table} WHERE id=?`,
        )
        .bind(a.target_id)
        .first<Row>();
    if (r) {
      const p =
          BigInt(r.paid_amount_paise as number) -
          BigInt(a.amount_paise as number),
        o = {
          id: Number(r.id),
          companyId: 0,
          partyId: 0,
          documentDate: "",
          dueDate: null,
          total: BigInt(r.total_amount_paise as number) as Money,
          paid: (p < 0n ? 0n : p) as Money,
        };
      m.push(...syncMutation(table, o, t));
    }
  }
  m.push(
    sql("DELETE FROM payment_allocations WHERE payment_id=?", id),
    sql("DELETE FROM payments WHERE id=?", id),
  );
  return { type: "Payment", id, status: "deleted", before: old, mutations: m };
}
