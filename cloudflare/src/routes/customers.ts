import { Hono } from "hono";
import type { AppVariables, AuthUser, Env } from "../types";
import { can } from "../security/permissions";
import { ReportRepository } from "../reports";
import type { CustomerProfileSection } from "../reports/repository";

const customers = new Hono<{ Bindings: Env; Variables: AppVariables }>();
type Row = Record<string, unknown>;

function allowed(c: { get(name: "user"): AuthUser | null }): boolean {
  return can(c.get("user"), "customers", "view");
}

function customerId(raw: string): number | null {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function requestedCompany(raw: string | undefined, user: AuthUser): number | undefined {
  if (user.activeCompanyId !== null) return user.activeCompanyId;
  if (!raw?.trim() || !/^[+-]?\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : undefined;
}

function validDate(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

function kolkataToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function period(c: { req: { query(name: string): string | undefined } }): { from: string; to: string } {
  const today = kolkataToday();
  const year = Number(today.slice(0, 4)) - (today.slice(5, 7) < "04" ? 1 : 0);
  let from = validDate(c.req.query("date_from")) ?? `${year}-04-01`;
  let to = validDate(c.req.query("date_to")) ?? today;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

function money(paise: unknown): string {
  const amount = Math.trunc(Number(paise ?? 0));
  const sign = amount < 0 ? "-" : "";
  const absolute = Math.abs(amount);
  const digits = String(Math.trunc(absolute / 100));
  const last = digits.slice(-3);
  const leading = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${sign}₹${leading ? `${leading},${last}` : last}.${String(absolute % 100).padStart(2, "0")}`;
}

function quantity(milliunits: unknown): string {
  const value = Math.trunc(Number(milliunits ?? 0));
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  const fraction = String(absolute % 1000).padStart(3, "0").replace(/0+$/, "");
  return `${sign}${Math.trunc(absolute / 1000)}${fraction ? `.${fraction}` : ""}`;
}

function weight(milliunits: unknown, unit: unknown): string {
  const value = Math.trunc(Number(milliunits ?? 0));
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  return `${sign}${Math.trunc(absolute / 1000)}.${String(absolute % 1000).padStart(3, "0")} ${String(unit ?? "")}`;
}

function timestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value).replace(/\.000Z$/, "").replace(/Z$/, "");
}

function customerJson(row: Row): Row {
  return {
    id: Number(row.id), code: row.code, customer_name: row.name, contact_person: row.contact_person,
    mobile: row.mobile, whatsapp: row.whatsapp, email: row.email, gst_number: row.gst_number,
    address: row.address, city: row.city, state: row.state, notes: row.notes, active: Boolean(row.active),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at),
  };
}

function companyJson(row: Row): Row {
  return { id: Number(row.id), code: row.code, name: row.name };
}

function identity(row: Row): string {
  const extra = row.mobile || row.city || row.gst_number;
  return `${String(row.code)} - ${String(row.name)}${extra ? ` · ${String(extra)}` : ""}`;
}

function invoiceJson(row: Row): Row {
  return {
    id: Number(row.id), company_id: Number(row.company_id), company: row.company,
    invoice_number: row.invoice_number, invoice_date: String(row.invoice_date), due_date: String(row.due_date ?? ""),
    sale_type: row.sale_type, total: money(row.grand_total_paise), paid: money(row.paid_amount_paise),
    pending: money(row.balance_amount_paise), status: row.payment_status,
    edit_url: `/transactions/sale/${Number(row.id)}/edit`, pdf_url: `/transactions/sale/${Number(row.id)}/export/pdf`,
  };
}

function challanJson(row: Row): Row {
  return {
    challan_number: row.challan_number, challan_date: String(row.challan_date),
    item_name: `${String(row.item_code)} - ${String(row.item_name)} (${String(row.unit)})`,
    quantity: quantity(row.quantity_milliunits), weight: weight(row.quantity_milliunits, row.unit),
    status: row.payment_status === "PAID" ? "Completed" : "Pending",
    pdf_url: `/transactions/sale/${Number(row.sale_id)}/export/pdf`,
  };
}

function paymentJson(row: Row): Row {
  return {
    id: Number(row.id), company_id: Number(row.company_id), company: row.company,
    payment_date: String(row.payment_date), payment_mode: row.mode, amount: money(row.total_amount_paise),
    allocated: money(row.allocated_amount_paise), pending: money(row.unallocated_amount_paise),
    reference_number: row.reference_number, remarks: row.remarks,
  };
}

function documentJson(row: Row): Row {
  return {
    label: `Invoice PDF - ${String(row.invoice_number)}`, type: "Invoice PDF", date: String(row.invoice_date),
    sale_id: Number(row.id), url: `/transactions/sale/${Number(row.id)}/export/pdf`,
  };
}

function profileJson(profile: Row): Row {
  const sales = (profile.sales as Row[]) ?? [];
  const payments = (profile.payments as Row[]) ?? [];
  const stockRows = (profile.stockRows as Row[]) ?? [];
  const receivable = (profile.receivable as Row) ?? {};
  const totalSales = sales.reduce((sum, row) => sum + Number(row.grand_total_paise ?? 0), 0);
  const totalReceived = payments.reduce((sum, row) => sum + Number(row.total_amount_paise ?? 0), 0);
  const stockGiven = stockRows.reduce((sum, row) => sum + Number(row.quantity_milliunits ?? 0), 0);
  const pendingStock = stockRows.reduce((sum, row) => row.payment_status === "PAID" ? sum : sum + Number(row.quantity_milliunits ?? 0), 0);
  const lastInvoice = sales.reduce<string>((latest, row) => String(row.invoice_date) > latest ? String(row.invoice_date) : latest, "");
  const lastTransaction = [lastInvoice, String(receivable.last_transaction ?? "")].sort().at(-1) ?? "";
  const lastPayment = payments.reduce<string>((latest, row) => String(row.payment_date) > latest ? String(row.payment_date) : latest, "");
  const summary = {
    total_invoices: sales.length, total_sales: money(totalSales), total_received: money(totalReceived),
    total_pending: money(receivable.balance_paise), last_transaction_date: lastTransaction,
    last_payment_date: lastPayment, stock_given: quantity(stockGiven), stock_received_back: "0", pending_stock: quantity(pendingStock),
  };
  const invoices = sales.map(invoiceJson);
  const challans = stockRows.map(challanJson);
  return {
    customer: customerJson(profile.customer as Row), companies: ((profile.companies as Row[]) ?? []).map(companyJson),
    summary, invoices, challans, stock: { summary: {
      stock_given: summary.stock_given, stock_received_back: summary.stock_received_back, pending_stock: summary.pending_stock,
    }, rows: challans }, payments: payments.map(paymentJson), documents: sales.map(documentJson),
  };
}

async function loadProfile(c: any, id: number, sections?: readonly CustomerProfileSection[]): Promise<Row | null> {
  const user = c.get("user") as AuthUser;
  const companyId = requestedCompany(c.req.query("company_id"), user);
  try {
    const profile = await new ReportRepository(c.env.DB, { activeCompanyId: user.activeCompanyId })
      .customerProfile(id, { ...period(c), ...(companyId === undefined ? {} : { companyId }) }, sections);
    return profileJson(profile);
  } catch (error) {
    if (error instanceof RangeError && error.message === "Customer not found") return null;
    throw error;
  }
}

customers.get("", async (c) => {
  if (!allowed(c)) return c.text("Forbidden", 403);
  const user = c.get("user")!;
  const selectedCompany = requestedCompany(c.req.query("company_id"), user);
  const activeFilter = c.req.query("active") ?? "active";
  const activeWhere = activeFilter === "active" ? " AND c.active=1" : activeFilter === "inactive" ? " AND c.active=0" : "";
  const query = (c.req.query("q") ?? "").trim().toLowerCase();
  const like = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const companyFilter = selectedCompany === undefined ? "" : ` AND (
    NOT EXISTS(SELECT 1 FROM linked original WHERE original.customer_id=c.id)
    OR EXISTS(SELECT 1 FROM linked selected WHERE selected.customer_id=c.id AND selected.company_id=?)
  )`;
  const searchFilter = query ? ` AND (
    LOWER(c.code) LIKE ? ESCAPE '\\' OR LOWER(c.name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.contact_person,'')) LIKE ? ESCAPE '\\'
    OR LOWER(COALESCE(c.mobile,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.whatsapp,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.email,'')) LIKE ? ESCAPE '\\'
    OR LOWER(COALESCE(c.gst_number,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.address,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.city,'')) LIKE ? ESCAPE '\\'
    OR LOWER(COALESCE(c.state,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.notes,'')) LIKE ? ESCAPE '\\'
    OR EXISTS(SELECT 1 FROM row_links search_link JOIN companies search_company ON search_company.id=search_link.company_id
      WHERE search_link.customer_id=c.id AND (LOWER(search_company.code) LIKE ? ESCAPE '\\' OR LOWER(search_company.name) LIKE ? ESCAPE '\\'))
  )` : "";
  const rowLinks = selectedCompany === undefined ? "SELECT customer_id,company_id FROM linked" : `
    SELECT customer_id,company_id FROM linked
    UNION SELECT c2.id,? FROM customers c2 WHERE NOT EXISTS(SELECT 1 FROM linked l2 WHERE l2.customer_id=c2.id)`;
  const values: unknown[] = [
    ...(selectedCompany === undefined ? [] : [selectedCompany]),
    ...(selectedCompany === undefined ? [] : [selectedCompany]),
    ...(query ? Array(13).fill(like) : []),
  ];
  const result = await c.env.DB.prepare(`WITH linked(customer_id,company_id) AS (
      SELECT customer_id,company_id FROM sales WHERE is_void=0
      UNION SELECT customer_id,company_id FROM receivables WHERE customer_id IS NOT NULL
      UNION SELECT customer_id,company_id FROM payments WHERE customer_id IS NOT NULL
    ), row_links(customer_id,company_id) AS (${rowLinks})
    SELECT c.id,c.code,c.name,c.contact_person,c.mobile,c.whatsapp,c.email,c.gst_number,c.address,c.city,c.state,c.notes,
      c.active,c.created_at,c.updated_at,co.id linked_company_id,co.code linked_company_code,co.name linked_company_name
    FROM customers c LEFT JOIN row_links rl ON rl.customer_id=c.id LEFT JOIN companies co ON co.id=rl.company_id
    WHERE 1=1${activeWhere}${companyFilter}${searchFilter}
    ORDER BY LOWER(c.code),LOWER(c.name),c.id,co.id`).bind(...values).all<Row>();
  const grouped = new Map<number, { customer: Row; companies: Row[]; display: string }>();
  for (const row of result.results) {
    const id = Number(row.id);
    let item = grouped.get(id);
    if (!item) {
      item = { customer: customerJson(row), companies: [], display: identity(row) };
      grouped.set(id, item);
    }
    if (row.linked_company_id !== null && row.linked_company_id !== undefined) {
      item.companies.push({ id: Number(row.linked_company_id), code: row.linked_company_code, name: row.linked_company_name });
    }
  }
  return c.json({ customers: [...grouped.values()].map((item) => ({ ...item.customer, companies: item.companies, display: item.display })) });
});

customers.get("/:customerId", async (c) => {
  if (!allowed(c)) return c.text("Forbidden", 403);
  const id = customerId(c.req.param("customerId"));
  if (!id) return c.text("Invalid customer", 400);
  const profile = await loadProfile(c, id);
  return profile ? c.json(profile) : c.notFound();
});

customers.get("/:customerId/invoices", async (c) => {
  if (!allowed(c)) return c.text("Forbidden", 403);
  const id = customerId(c.req.param("customerId"));
  if (!id) return c.text("Invalid customer", 400);
  const profile = await loadProfile(c, id, ["sales"]);
  return profile ? c.json({ invoices: profile.invoices }) : c.notFound();
});

customers.get("/:customerId/challans", async (c) => {
  if (!allowed(c)) return c.text("Forbidden", 403);
  const id = customerId(c.req.param("customerId"));
  if (!id) return c.text("Invalid customer", 400);
  const profile = await loadProfile(c, id, ["stockRows"]);
  return profile ? c.json({ challans: profile.challans }) : c.notFound();
});

customers.get("/:customerId/payments", async (c) => {
  if (!allowed(c)) return c.text("Forbidden", 403);
  const id = customerId(c.req.param("customerId"));
  if (!id) return c.text("Invalid customer", 400);
  const profile = await loadProfile(c, id, ["payments"]);
  return profile ? c.json({ payments: profile.payments }) : c.notFound();
});

customers.get("/:customerId/stock", async (c) => {
  if (!allowed(c)) return c.text("Forbidden", 403);
  const id = customerId(c.req.param("customerId"));
  if (!id) return c.text("Invalid customer", 400);
  const profile = await loadProfile(c, id, ["stockRows"]);
  if (!profile) return c.notFound();
  const stock = profile.stock as Row;
  return c.json({ summary: stock.summary, stock: stock.rows });
});

export default customers;
