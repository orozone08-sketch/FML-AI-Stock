import { checkedD1Integer } from "../domain";

export type SqlMutation = { sql: string; params: readonly unknown[] };
export const sql = (text: string, ...params: unknown[]): SqlMutation => ({ sql: text, params });
export const dbInt = (value: bigint) => checkedD1Integer(value);

export function prepared(db: D1Database, mutations: readonly SqlMutation[]): D1PreparedStatement[] {
  return mutations.map((mutation) => db.prepare(mutation.sql).bind(...mutation.params));
}

type IdTable = "opening_stocks"|"opening_stock_lines"|"purchases"|"purchase_lines"|"sales"|"sale_lines"|"inter_company_transfers"|"transfer_lines"|"fifo_layers"|"fifo_consumptions"|"stock_ledger_entries"|"receivables"|"payables"|"payments"|"payment_allocations"|"inter_company_ledger_entries"|"audit_logs"|"idempotency_keys";

export async function nextIds<const T extends readonly IdTable[]>(db: D1Database, tables: T): Promise<Record<T[number], number>> {
  const allowed = new Set(["opening_stocks","opening_stock_lines","purchases","purchase_lines","sales","sale_lines","inter_company_transfers","transfer_lines","fifo_layers","fifo_consumptions","stock_ledger_entries","receivables","payables","payments","payment_allocations","inter_company_ledger_entries","audit_logs","idempotency_keys"]);
  const statements = tables.map((table) => {
    if (!allowed.has(table)) throw new Error(`Unsafe ID table: ${table}`);
    return db.prepare(`SELECT COALESCE(MAX(id),0)+1 AS id FROM ${table}`);
  });
  const results = await db.batch<{ id: number }>(statements);
  return Object.fromEntries(tables.map((table, index) => [table, Number(results[index]?.results[0]?.id ?? 1)])) as Record<T[number], number>;
}
