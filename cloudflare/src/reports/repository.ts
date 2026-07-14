import { REPORTS } from "./catalog";
import { normalizeFilters } from "./filters";
import type { CompanyScope, ReportFilters, ReportResult } from "./types";

type Row = Record<string, unknown>;

function add(where: string[], values: unknown[], expression: string, value: unknown): void { where.push(expression); values.push(value); }

export class ReportRepository {
  constructor(private readonly db: D1Database, private readonly scope: CompanyScope) {}

  async named(name: string, input: ReportFilters = {}): Promise<ReportResult> {
    const definition = REPORTS[name];
    if (!definition) throw new RangeError("Unknown report");
    const filters = normalizeFilters(input, this.scope);
    const where: string[] = []; const values: unknown[] = [];
    if (filters.companyId && definition.companyColumn) add(where, values, `${definition.companyColumn}=?`, filters.companyId);
    if (filters.from && definition.dateColumn) add(where, values, `${definition.dateColumn}>=?`, filters.from);
    if (filters.to && definition.dateColumn) add(where, values, `${definition.dateColumn}<=?`, filters.to);
    if (filters.itemId) add(where, values, `${name.includes("price-fluctuation") ? "l" : name === "current-stock" || name === "stock-alerts" ? "b" : name.startsWith("fifo") ? "f" : "l"}.item_id=?`, filters.itemId);
    if (filters.stockBookId) add(where, values, `${name === "current-stock" || name === "stock-alerts" ? "b" : name.startsWith("fifo") ? "f" : "l"}.stock_book_id=?`, filters.stockBookId);
    if (filters.customerId && ["sales","gross-profit"].includes(name)) add(where, values, "s.customer_id=?", filters.customerId);
    if (filters.cursorDate && filters.cursorId && definition.dateColumn) { where.push(`(${definition.dateColumn}<? OR (${definition.dateColumn}=? AND id<?))`); values.push(filters.cursorDate, filters.cursorDate, filters.cursorId); }
    const grouped = ["fifo-valuation","purchases-monthly","sales-monthly","sales-by-type","customer-outstanding","supplier-outstanding"].includes(name);
    const groups: Record<string,string> = {
      "fifo-valuation":"f.company_id,f.stock_book_id,f.item_id", "purchases-monthly":"substr(p.bill_date,1,7),p.company_id",
      "sales-monthly":"substr(s.invoice_date,1,7),s.company_id", "sales-by-type":"s.company_id,s.sale_type",
      "customer-outstanding":"r.company_id,r.customer_id", "supplier-outstanding":"p.company_id,p.supplier_id",
    };
    const sql = `${definition.sql}${where.length ? ` AND ${where.join(" AND ")}` : ""}${grouped ? ` GROUP BY ${groups[name]}` : ""} ORDER BY ${definition.dateColumn ? "date DESC," : ""} id DESC LIMIT ?`;
    values.push(filters.limit + 1);
    const result = await this.db.prepare(sql).bind(...values).all<Row>();
    const rows = result.results.slice(0, filters.limit);
    const last = rows.at(-1); const date = last?.date;
    return { rows, hasMore: result.results.length > filters.limit, nextCursor: result.results.length > filters.limit && typeof date === "string" ? { date, id: Number(last?.id) } : null };
  }

  async customerProfile(customerId: number, input: ReportFilters = {}): Promise<Row> {
    const f = normalizeFilters({ ...input, customerId }, this.scope); const company = f.companyId ? " AND r.company_id=?" : ""; const args = f.companyId ? [customerId, f.companyId] : [customerId];
    const [customer, receivable, sales, payments] = await this.db.batch([
      this.db.prepare("SELECT id,code,name,contact_person,customer_type,gst_number,mobile,whatsapp,email,address,city,state,default_credit_days,active,notes FROM customers WHERE id=?").bind(customerId),
      this.db.prepare(`SELECT COALESCE(SUM(r.total_amount_paise),0) total_paise,COALESCE(SUM(r.balance_amount_paise),0) balance_paise,COUNT(r.id) document_count FROM receivables r WHERE r.customer_id=?${company}`).bind(...args),
      this.db.prepare(`SELECT s.id,s.invoice_date,s.invoice_number,s.grand_total_paise,s.balance_amount_paise,s.payment_status FROM sales s WHERE s.customer_id=?${f.companyId ? " AND s.company_id=?" : ""} AND s.is_void=0 ORDER BY s.invoice_date DESC,s.id DESC LIMIT 101`).bind(...args),
      this.db.prepare(`SELECT p.id,p.payment_date,p.payment_type,p.mode,p.reference_number,p.total_amount_paise,p.unallocated_amount_paise FROM payments p WHERE p.customer_id=?${f.companyId ? " AND p.company_id=?" : ""} ORDER BY p.payment_date DESC,p.id DESC LIMIT 101`).bind(...args),
    ]);
    if (!customer?.results[0]) throw new RangeError("Customer not found");
    return { customer: customer.results[0], metrics: receivable?.results[0] ?? {}, sales: sales?.results ?? [], payments: payments?.results ?? [] };
  }

  async supplierProfile(supplierId: number, input: ReportFilters = {}): Promise<Row> {
    const f = normalizeFilters({ ...input, supplierId }, this.scope); const args = f.companyId ? [supplierId, f.companyId] : [supplierId]; const scope = f.companyId ? " AND p.company_id=?" : "";
    const [supplier, metrics, purchases, payments] = await this.db.batch([
      this.db.prepare("SELECT id,code,name,gst_number,mobile,email,address,default_credit_days,active FROM suppliers WHERE id=?").bind(supplierId),
      this.db.prepare(`SELECT COALESCE(SUM(p.total_amount_paise),0) total_paise,COALESCE(SUM(p.balance_amount_paise),0) balance_paise,COUNT(p.id) document_count FROM payables p WHERE p.supplier_id=?${scope}`).bind(...args),
      this.db.prepare(`SELECT p.id,p.bill_date,p.bill_number,p.grand_total_paise,p.balance_amount_paise,p.payment_status FROM purchases p WHERE p.supplier_id=?${scope} AND p.is_void=0 ORDER BY p.bill_date DESC,p.id DESC LIMIT 101`).bind(...args),
      this.db.prepare(`SELECT p.id,p.payment_date,p.payment_type,p.mode,p.reference_number,p.total_amount_paise,p.unallocated_amount_paise FROM payments p WHERE p.supplier_id=?${scope} ORDER BY p.payment_date DESC,p.id DESC LIMIT 101`).bind(...args),
    ]);
    if (!supplier?.results[0]) throw new RangeError("Supplier not found");
    return { supplier: supplier.results[0], metrics: metrics?.results[0] ?? {}, purchases: purchases?.results ?? [], payments: payments?.results ?? [] };
  }

  async calendar(input: ReportFilters): Promise<Row[]> {
    const f = normalizeFilters(input, this.scope); if (!f.from || !f.to) throw new RangeError("Calendar requires from and to"); const company = f.companyId ? " AND company_id=?" : ""; const args = f.companyId ? [f.from, f.to, f.companyId] : [f.from, f.to];
    const results = await this.db.batch([
      this.db.prepare(`SELECT id,invoice_date date,invoice_number title,'sale' type FROM sales WHERE is_void=0 AND invoice_date BETWEEN ? AND ?${company} ORDER BY invoice_date,id LIMIT 200`).bind(...args),
      this.db.prepare(`SELECT id,bill_date date,bill_number title,'purchase' type FROM purchases WHERE is_void=0 AND bill_date BETWEEN ? AND ?${company} ORDER BY bill_date,id LIMIT 200`).bind(...args),
      this.db.prepare(`SELECT id,due_date date,document_number title,'receivable-due' type FROM receivables WHERE balance_amount_paise>0 AND due_date BETWEEN ? AND ?${company} ORDER BY due_date,id LIMIT 200`).bind(...args),
      this.db.prepare(`SELECT id,due_date date,document_number title,'payable-due' type FROM payables WHERE balance_amount_paise>0 AND due_date BETWEEN ? AND ?${company} ORDER BY due_date,id LIMIT 200`).bind(...args),
    ]);
    return results.flatMap((result) => result.results as Row[]).sort((a,b) => String(a.date).localeCompare(String(b.date)) || Number(a.id)-Number(b.id)).slice(0, 500);
  }
}
