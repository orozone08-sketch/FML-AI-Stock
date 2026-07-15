import { REPORTS } from "./catalog";
import { normalizeFilters } from "./filters";
import type { CompanyScope, ReportFilters, ReportResult } from "./types";

type Row = Record<string, unknown>;
export type CustomerProfileSection = "companies" | "sales" | "receivable" | "payments" | "stockRows";

function add(where: string[], values: unknown[], expression: string, value: unknown): void { where.push(expression); values.push(value); }

// Never use an unqualified `id` in joined report SQL: SQLite resolves ORDER BY
// and keyset predicates against every input table, not just the projected alias.
const ID_COLUMN: Readonly<Record<string,string>> = {
  "current-stock":"b.item_id", "fifo-valuation":"f.id", "fifo-layers":"f.id", "stock-ledger":"l.id",
  purchases:"p.id", "purchases-monthly":"p.id", sales:"s.id", "sales-monthly":"s.id", "sales-by-type":"s.id",
  "gross-profit":"s.id", "customer-outstanding":"r.id", "supplier-outstanding":"p.id", advances:"p.id",
  "payment-history":"p.id", "due-alerts":"x.id", "stock-alerts":"b.item_id", "inter-company":"l.id",
  "opening-summary":"x.id", "purchase-price-fluctuation":"x.id", "sale-price-fluctuation":"x.id",
  audit:"a.id", "item-ledger":"l.id", "customer-ledger":"x.id",
};
const CUSTOMER_COLUMN: Readonly<Record<string,string>> = {
  sales:"s.customer_id", "gross-profit":"s.customer_id", "customer-outstanding":"r.customer_id", "sale-price-fluctuation":"x.customer_id",
  "customer-ledger":"x.customer_id", advances:"p.customer_id", "payment-history":"p.customer_id",
};
const SUPPLIER_COLUMN: Readonly<Record<string,string>> = {
  purchases:"p.supplier_id", "supplier-outstanding":"p.supplier_id", advances:"p.supplier_id", "purchase-price-fluctuation":"x.supplier_id",
  "payment-history":"p.supplier_id",
};
const KEY_COLUMN: Readonly<Record<string,string>> = {
  "current-stock":"printf('%010d:%010d:%010d',sb.company_id,sb.id,i.id)",
  "stock-alerts":"printf('%010d:%010d:%010d',sb.company_id,sb.id,i.id)",
};
const ITEM_FILTER:Readonly<Record<string,string>>={
  "current-stock":"i.id=?","stock-alerts":"i.id=?","fifo-valuation":"f.item_id=?","fifo-layers":"f.item_id=?",
  "stock-ledger":"l.item_id=?","item-ledger":"l.item_id=?","purchase-price-fluctuation":"x.item_id=?","sale-price-fluctuation":"x.item_id=?",
  purchases:"EXISTS(SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id=p.id AND pl.item_id=?)",
  sales:"EXISTS(SELECT 1 FROM sale_lines sl WHERE sl.sale_id=s.id AND sl.item_id=?)",
  "gross-profit":"EXISTS(SELECT 1 FROM sale_lines sl WHERE sl.sale_id=s.id AND sl.item_id=?)",
};
const BOOK_FILTER:Readonly<Record<string,string>>={
  "current-stock":"sb.id=?","stock-alerts":"sb.id=?","fifo-valuation":"f.stock_book_id=?","fifo-layers":"f.stock_book_id=?",
  "stock-ledger":"l.stock_book_id=?","item-ledger":"l.stock_book_id=?",purchases:"p.stock_book_id=?",sales:"s.stock_book_id=?","gross-profit":"s.stock_book_id=?",
};

export class ReportRepository {
  constructor(private readonly db: D1Database, private readonly scope: CompanyScope) {}

  async named(name: string, input: ReportFilters = {}): Promise<ReportResult> {
    const definition = REPORTS[name];
    if (!definition) throw new RangeError("Unknown report");
    const filters = normalizeFilters(input, this.scope);
    const where: string[] = []; const values: unknown[] = [];
    if (filters.companyId && name === "inter-company") { where.push("(l.stock_owner_company_id=? OR l.stock_user_company_id=?)"); values.push(filters.companyId, filters.companyId); }
    else if (filters.companyId && definition.companyColumn) add(where, values, `${definition.companyColumn}=?`, filters.companyId);
    if (filters.from && definition.dateColumn) add(where, values, `${definition.dateColumn}>=?`, filters.from);
    if (filters.to && definition.dateColumn) add(where, values, `${definition.dateColumn}<=?`, filters.to);
    if(filters.itemId){const expression=ITEM_FILTER[name];if(!expression)throw new RangeError(`${name} does not support itemId`);add(where,values,expression,filters.itemId);}
    if(filters.stockBookId){const expression=BOOK_FILTER[name];if(!expression)throw new RangeError(`${name} does not support stockBookId`);add(where,values,expression,filters.stockBookId);}
    if (filters.customerId) {
      const column=CUSTOMER_COLUMN[name]; if(!column) throw new RangeError(`${name} does not support customerId`);
      add(where,values,`${column}=?`,filters.customerId);
    }
    if (filters.supplierId) {
      const column=SUPPLIER_COLUMN[name]; if(!column) throw new RangeError(`${name} does not support supplierId`);
      add(where,values,`${column}=?`,filters.supplierId);
    }
    if (filters.query) {
      if (name === "customer-outstanding") { const like=`%${filters.query.toLowerCase()}%`; where.push("(LOWER(r.customer_code) LIKE ? OR LOWER(r.customer) LIKE ? OR LOWER(r.documents) LIKE ?)"); values.push(like,like,like); }
      else if (name === "supplier-outstanding") { const like=`%${filters.query.toLowerCase()}%`; where.push("(LOWER(p.supplier_code) LIKE ? OR LOWER(p.supplier) LIKE ? OR LOWER(p.documents) LIKE ?)"); values.push(like,like,like); }
      else throw new RangeError(`${name} does not support query`);
    }
    if (filters.status) {
      if (name === "customer-outstanding") add(where,values,"r.status=?",filters.status);
      else if (name === "supplier-outstanding") add(where,values,"p.status=?",filters.status);
      else throw new RangeError(`${name} does not support status`);
    }
    const idColumn = ID_COLUMN[name];
    if (!idColumn) throw new Error(`Report ${name} has no deterministic ID column.`);
    if (filters.cursorDate && filters.cursorId && definition.dateColumn) { where.push(`(${definition.dateColumn}<? OR (${definition.dateColumn}=? AND ${idColumn}<?))`); values.push(filters.cursorDate, filters.cursorDate, filters.cursorId); }
    else if (filters.cursorId && !definition.dateColumn && !KEY_COLUMN[name]) add(where,values,`${idColumn}<?`,filters.cursorId);
    if(filters.cursorKey){const column=KEY_COLUMN[name];if(!column)throw new RangeError(`${name} does not support cursorKey`);add(where,values,`${column}<?`,filters.cursorKey);}
    const grouped = ["fifo-valuation","purchases-monthly","sales-monthly","sales-by-type"].includes(name);
    const groups: Record<string,string> = {
      "fifo-valuation":"f.company_id,f.stock_book_id,f.item_id", "purchases-monthly":"substr(p.bill_date,1,7),p.company_id",
      "sales-monthly":"substr(s.invoice_date,1,7),s.company_id", "sales-by-type":"s.company_id,s.sale_type",
    };
    const orderColumn=KEY_COLUMN[name]??idColumn;
    const sql = `${definition.sql}${where.length ? ` AND ${where.join(" AND ")}` : ""}${grouped ? ` GROUP BY ${groups[name]}` : ""} ORDER BY ${definition.dateColumn ? `${definition.dateColumn} DESC,` : ""} ${orderColumn} DESC LIMIT ?`;
    values.push(filters.limit + 1);
    const result = await this.db.prepare(sql).bind(...values).all<Row>();
    const pageRows = result.results.slice(0, filters.limit);
    const last = pageRows.at(-1); const date = last?.date; const key=last?.cursor_key;
    const hasMore=result.results.length > filters.limit;
    const nextCursor=!hasMore?null:typeof date==="string"?{date,id:Number(last?.id)}:typeof key==="string"?{key}:Number.isSafeInteger(Number(last?.id))?{id:Number(last?.id)}:null;
    const rows=pageRows.map(({cursor_key: _cursorKey,...row})=>row);
    return { rows, hasMore, nextCursor };
  }

  async customerProfile(customerId: number, input: ReportFilters = {}, sections?: readonly CustomerProfileSection[]): Promise<Row> {
    if (!Number.isSafeInteger(customerId) || customerId <= 0) throw new RangeError("Invalid customerId");
    const companyId = this.scope.activeCompanyId ?? input.companyId;
    if (companyId !== undefined && companyId !== null && !Number.isSafeInteger(companyId)) throw new RangeError("Invalid companyId");
    const joinedCompany = companyId === undefined || companyId === null ? "" : " AND s.company_id=?";
    const receivableCompany = companyId === undefined || companyId === null ? "" : " AND r.company_id=?";
    const paymentCompany = companyId === undefined || companyId === null ? "" : " AND p.company_id=?";
    const dates = [input.from ? " AND DATE_COLUMN>=?" : "", input.to ? " AND DATE_COLUMN<=?" : ""].join("");
    const bind = (): unknown[] => [
      customerId,
      ...(companyId === undefined || companyId === null ? [] : [companyId]),
      ...(input.from ? [input.from] : []),
      ...(input.to ? [input.to] : []),
    ];
    const dateWhere = (column: string): string => dates.replaceAll("DATE_COLUMN", column);
    const companySelection = companyId === undefined || companyId === null
      ? `co.id IN (
          SELECT s.company_id FROM sales s WHERE s.customer_id=? AND s.is_void=0
          UNION SELECT r.company_id FROM receivables r WHERE r.customer_id=?
          UNION SELECT p.company_id FROM payments p WHERE p.customer_id=?
        )`
      : "co.id=?";
    const companyArgs = companyId === undefined || companyId === null
      ? [customerId, customerId, customerId]
      : [companyId];

    const requested = new Set<CustomerProfileSection>(sections ?? ["companies", "sales", "receivable", "payments", "stockRows"]);
    const statements: D1PreparedStatement[] = [
      this.db.prepare("SELECT id,code,name,contact_person,gst_number,mobile,whatsapp,email,address,city,state,notes,active,created_at,updated_at FROM customers WHERE id=?").bind(customerId),
    ];
    const keys: Array<"customer" | CustomerProfileSection> = ["customer"];
    const addSection = (key: CustomerProfileSection, statement: () => D1PreparedStatement): void => {
      if (requested.has(key)) { keys.push(key); statements.push(statement()); }
    };
    addSection("companies", () => this.db.prepare(`SELECT co.id,co.code,co.name FROM companies co WHERE ${companySelection} ORDER BY co.id`).bind(...companyArgs));
    addSection("sales", () => this.db.prepare(`SELECT s.id,s.company_id,co.code company,s.invoice_number,s.invoice_date,s.due_date,s.sale_type,s.grand_total_paise,s.paid_amount_paise,s.balance_amount_paise,s.payment_status
        FROM sales s JOIN companies co ON co.id=s.company_id
        WHERE s.customer_id=?${joinedCompany} AND s.is_void=0${dateWhere("s.invoice_date")}
        ORDER BY s.invoice_date DESC,s.id DESC`).bind(...bind()));
    addSection("receivable", () => this.db.prepare(`SELECT COALESCE(SUM(r.balance_amount_paise),0) balance_paise,MAX(r.document_date) last_transaction
        FROM receivables r WHERE r.customer_id=?${receivableCompany}${dateWhere("r.document_date")}`).bind(...bind()));
    addSection("payments", () => this.db.prepare(`SELECT p.id,p.company_id,co.code company,p.payment_date,p.mode,p.total_amount_paise,p.allocated_amount_paise,p.unallocated_amount_paise,p.reference_number,p.remarks
        FROM payments p JOIN companies co ON co.id=p.company_id
        WHERE p.customer_id=?${paymentCompany}${dateWhere("p.payment_date")}
        ORDER BY p.payment_date DESC,p.id DESC`).bind(...bind()));
    addSection("stockRows", () => this.db.prepare(`SELECT sl.id,s.id sale_id,s.invoice_number challan_number,s.invoice_date challan_date,s.payment_status,
          i.code item_code,i.name item_name,i.unit,sl.quantity_milliunits
        FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id JOIN items i ON i.id=sl.item_id
        WHERE s.customer_id=?${joinedCompany} AND s.is_void=0${dateWhere("s.invoice_date")}
        ORDER BY s.invoice_date DESC,s.id DESC,sl.id`).bind(...bind()));

    // The batch is fixed at six queries for detail and two for every child route,
    // independent of the number of invoices, payments, or sale lines.
    const results = await this.db.batch(statements);
    const byKey = Object.fromEntries(keys.map((key, index) => [key, results[index]?.results ?? []])) as Record<string, Row[]>;
    if (!byKey.customer?.[0]) throw new RangeError("Customer not found");
    return {
      customer: byKey.customer[0], companies: byKey.companies ?? [], sales: byKey.sales ?? [],
      receivable: byKey.receivable?.[0] ?? { balance_paise: 0, last_transaction: null },
      payments: byKey.payments ?? [], stockRows: byKey.stockRows ?? [],
    };
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
      this.db.prepare(`SELECT id,due_date date,document_number title,'receivable-due' type,CASE WHEN due_date<date('now') THEN 'danger' ELSE 'warning' END severity FROM receivables WHERE balance_amount_paise>0 AND due_date BETWEEN ? AND ?${company} ORDER BY due_date,id LIMIT 200`).bind(...args),
      this.db.prepare(`SELECT id,due_date date,document_number title,'payable-due' type,CASE WHEN due_date<date('now') THEN 'danger' ELSE 'warning' END severity FROM payables WHERE balance_amount_paise>0 AND due_date BETWEEN ? AND ?${company} ORDER BY due_date,id LIMIT 200`).bind(...args),
      this.db.prepare(`SELECT id,payment_date date,COALESCE(reference_number,payment_type) title,'payment' type FROM payments WHERE payment_date BETWEEN ? AND ?${company} ORDER BY payment_date,id LIMIT 200`).bind(...args),
      this.db.prepare(`SELECT i.id,? date,i.name||' · '||sb.name title,CASE WHEN COALESCE(b.quantity_milliunits,0)<=0 THEN 'stock-out' ELSE 'low-stock' END type FROM stock_books sb CROSS JOIN items i LEFT JOIN inventory_balances b ON b.company_id=sb.company_id AND b.stock_book_id=sb.id AND b.item_id=i.id WHERE ? BETWEEN ? AND ? AND sb.active=1 AND i.active=1 AND COALESCE(b.quantity_milliunits,0)<=i.minimum_stock_milliunits${f.companyId?" AND sb.company_id=?":""} ORDER BY i.code,sb.code,i.id LIMIT 200`).bind(todayForCalendar(),todayForCalendar(),f.from,f.to,...(f.companyId?[f.companyId]:[])),
    ]);
    const events:Row[]=results.flatMap((result) => result.results as Row[]).map((row):Row=>({...row,url:calendarUrl(row)}));
    return events.sort((a,b) => String(a.date).localeCompare(String(b.date)) || Number(a.id)-Number(b.id)).slice(0, 500);
  }
}

function todayForCalendar():string { return new Date().toISOString().slice(0,10); }
function calendarUrl(row:Row):string { const id=Number(row.id);switch(row.type){case"sale":return `/transactions/sale/${id}/view`;case"purchase":return `/transactions/purchase/${id}/print`;case"payment":return `/finance/payments/${id}/print`;case"stock-out":case"low-stock":return `/reports/item-ledger?item_id=${id}`;default:return "/finance/outstanding";} }
