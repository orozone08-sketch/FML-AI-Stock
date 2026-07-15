import type { Env } from "./types";

export const MAINTENANCE_LIMITS = Object.freeze({
  sessions: 100,
  loginAttempts: 100,
  idempotencyKeys: 100,
  r2Objects: 20,
  reconciliationKeys: 20,
});

const LOGIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const R2_PENDING_GRACE_MS = 24 * 60 * 60 * 1_000;
type Row = Record<string, number | string | null>;

export interface MaintenanceResult {
  deleted: { sessions: number; loginAttempts: number; idempotencyKeys: number; r2Objects: number };
  reconciliation: { phase: "BALANCES" | "LEDGER"; checked: number; mismatches: number; reset: boolean };
}

async function boundedDelete(db: D1Database, table: string, timestampColumn: string, cutoff: string, limit: number) {
  const result = await db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${timestampColumn}<=? ORDER BY ${timestampColumn},id LIMIT ?)`)
    .bind(cutoff, limit).run();
  return Number(result.meta.changes ?? 0);
}

async function cleanupR2(env: Env, cutoff: string) {
  const rows = await env.DB.prepare("SELECT id,object_key FROM r2_objects WHERE lifecycle_state IN ('PENDING','ORPHANED') AND created_at<=? ORDER BY created_at,id LIMIT ?")
    .bind(cutoff, MAINTENANCE_LIMITS.r2Objects).all<Row>();
  const removed: number[] = [];
  for (const row of rows.results) {
    await env.FILES.delete(String(row.object_key));
    removed.push(Number(row.id));
  }
  if (removed.length) {
    await env.DB.batch(removed.map((id) => env.DB.prepare("DELETE FROM r2_objects WHERE id=? AND lifecycle_state IN ('PENDING','ORPHANED')").bind(id)));
  }
  return removed.length;
}

const BALANCE_RECONCILIATION = `
WITH slice AS (
 SELECT company_id,stock_book_id,item_id,quantity_milliunits,ledger_value_paise
 FROM inventory_balances
 WHERE (company_id>?) OR (company_id=? AND stock_book_id>?) OR (company_id=? AND stock_book_id=? AND item_id>?)
 ORDER BY company_id,stock_book_id,item_id LIMIT ?
)
SELECT b.company_id,b.stock_book_id,b.item_id,b.quantity_milliunits,b.ledger_value_paise,
 COALESCE(SUM(l.quantity_in_milliunits-l.quantity_out_milliunits),0) expected_quantity_milliunits,
 COALESCE(SUM(CASE l.movement_type WHEN 'IN' THEN l.value_paise ELSE -l.value_paise END),0) expected_ledger_value_paise,
 (SELECT id FROM alerts a WHERE a.alert_type='INVENTORY_RECONCILIATION' AND a.company_id=b.company_id AND a.stock_book_id=b.stock_book_id AND a.item_id=b.item_id AND a.resolved=0 ORDER BY a.id DESC LIMIT 1) alert_id
FROM slice b LEFT JOIN stock_ledger_entries l ON l.company_id=b.company_id AND l.stock_book_id=b.stock_book_id AND l.item_id=b.item_id
GROUP BY b.company_id,b.stock_book_id,b.item_id,b.quantity_milliunits,b.ledger_value_paise
ORDER BY b.company_id,b.stock_book_id,b.item_id`;

const LEDGER_RECONCILIATION = `
WITH ledger_slice AS (
 SELECT id,company_id,stock_book_id,item_id FROM stock_ledger_entries WHERE id>? ORDER BY id LIMIT ?
), keys AS (
 SELECT company_id,stock_book_id,item_id,MAX(id) slice_ledger_id FROM ledger_slice GROUP BY company_id,stock_book_id,item_id
)
SELECT k.company_id,k.stock_book_id,k.item_id,k.slice_ledger_id,
 b.quantity_milliunits,b.ledger_value_paise,
 SUM(l.quantity_in_milliunits-l.quantity_out_milliunits) expected_quantity_milliunits,
 SUM(CASE l.movement_type WHEN 'IN' THEN l.value_paise ELSE -l.value_paise END) expected_ledger_value_paise,
 (SELECT id FROM alerts a WHERE a.alert_type='INVENTORY_RECONCILIATION' AND a.company_id=k.company_id AND a.stock_book_id=k.stock_book_id AND a.item_id=k.item_id AND a.resolved=0 ORDER BY a.id DESC LIMIT 1) alert_id
FROM keys k
LEFT JOIN inventory_balances b ON b.company_id=k.company_id AND b.stock_book_id=k.stock_book_id AND b.item_id=k.item_id
JOIN stock_ledger_entries l ON l.company_id=k.company_id AND l.stock_book_id=k.stock_book_id AND l.item_id=k.item_id
GROUP BY k.company_id,k.stock_book_id,k.item_id,k.slice_ledger_id,b.quantity_milliunits,b.ledger_value_paise
ORDER BY k.slice_ledger_id`;

async function reconcile(env: Env, now: string): Promise<MaintenanceResult["reconciliation"]> {
  const cursor = await env.DB.prepare("SELECT phase,cursor_company_id,cursor_stock_book_id,cursor_item_id,cursor_ledger_id FROM maintenance_cursors WHERE job_name='inventory'").first<Row>();
  const phase = cursor?.phase === "LEDGER" ? "LEDGER" : "BALANCES";
  const c = Number(cursor?.cursor_company_id ?? 0), b = Number(cursor?.cursor_stock_book_id ?? 0), i = Number(cursor?.cursor_item_id ?? 0), l = Number(cursor?.cursor_ledger_id ?? 0);
  const query = phase === "BALANCES"
    ? env.DB.prepare(BALANCE_RECONCILIATION).bind(c, c, b, c, b, i, MAINTENANCE_LIMITS.reconciliationKeys)
    : env.DB.prepare(LEDGER_RECONCILIATION).bind(l, MAINTENANCE_LIMITS.reconciliationKeys);
  const result = await query.all<Row>();
  const mutations: D1PreparedStatement[] = [];
  let mismatches = 0;
  for (const row of result.results) {
    const mismatch = row.quantity_milliunits === null || row.ledger_value_paise === null
      || Number(row.quantity_milliunits) !== Number(row.expected_quantity_milliunits)
      || Number(row.ledger_value_paise) !== Number(row.expected_ledger_value_paise);
    if (mismatch) {
      mismatches++;
      if (row.alert_id === null) {
        const message = `Inventory read model differs from ledger: quantity ${row.quantity_milliunits ?? "missing"}/${row.expected_quantity_milliunits}, value ${row.ledger_value_paise ?? "missing"}/${row.expected_ledger_value_paise}.`;
        mutations.push(env.DB.prepare("INSERT INTO alerts(alert_type,severity,company_id,stock_book_id,item_id,message,resolved,created_at) VALUES('INVENTORY_RECONCILIATION','CRITICAL',?,?,?,?,0,?)")
          .bind(row.company_id, row.stock_book_id, row.item_id, message, now));
      }
    } else if (row.alert_id !== null) {
      mutations.push(env.DB.prepare("UPDATE alerts SET resolved=1 WHERE id=? AND resolved=0").bind(row.alert_id));
    }
  }
  const reset = result.results.length === 0;
  if (reset) {
    const nextPhase = phase === "BALANCES" ? "LEDGER" : "BALANCES";
    mutations.push(env.DB.prepare("INSERT INTO maintenance_cursors(job_name,phase,updated_at) VALUES('inventory',?,?) ON CONFLICT(job_name) DO UPDATE SET phase=excluded.phase,cursor_company_id=0,cursor_stock_book_id=0,cursor_item_id=0,cursor_ledger_id=0,updated_at=excluded.updated_at").bind(nextPhase, now));
  } else {
    const last = result.results.at(-1)!;
    mutations.push(phase === "BALANCES"
      ? env.DB.prepare("INSERT INTO maintenance_cursors(job_name,phase,cursor_company_id,cursor_stock_book_id,cursor_item_id,updated_at) VALUES('inventory','BALANCES',?,?,?,?) ON CONFLICT(job_name) DO UPDATE SET cursor_company_id=excluded.cursor_company_id,cursor_stock_book_id=excluded.cursor_stock_book_id,cursor_item_id=excluded.cursor_item_id,updated_at=excluded.updated_at").bind(last.company_id, last.stock_book_id, last.item_id, now)
      : env.DB.prepare("INSERT INTO maintenance_cursors(job_name,phase,cursor_ledger_id,updated_at) VALUES('inventory','LEDGER',?,?) ON CONFLICT(job_name) DO UPDATE SET cursor_ledger_id=excluded.cursor_ledger_id,updated_at=excluded.updated_at").bind(last.slice_ledger_id, now));
  }
  if (mutations.length) await env.DB.batch(mutations);
  return { phase, checked: result.results.length, mismatches, reset };
}

export async function runScheduledMaintenance(env: Env, at = new Date()): Promise<MaintenanceResult> {
  const now = at.toISOString();
  const loginCutoff = new Date(at.getTime() - LOGIN_RETENTION_MS).toISOString();
  const r2Cutoff = new Date(at.getTime() - R2_PENDING_GRACE_MS).toISOString();
  const [sessions, loginAttempts, idempotencyKeys] = await Promise.all([
    boundedDelete(env.DB, "sessions", "expires_at", now, MAINTENANCE_LIMITS.sessions),
    boundedDelete(env.DB, "login_attempts", "created_at", loginCutoff, MAINTENANCE_LIMITS.loginAttempts),
    boundedDelete(env.DB, "idempotency_keys", "expires_at", now, MAINTENANCE_LIMITS.idempotencyKeys),
  ]);
  const r2Objects = await cleanupR2(env, r2Cutoff);
  const reconciliation = await reconcile(env, now);
  return { deleted: { sessions, loginAttempts, idempotencyKeys, r2Objects }, reconciliation };
}

