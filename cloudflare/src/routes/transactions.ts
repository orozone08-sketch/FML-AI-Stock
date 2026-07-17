import { Hono, type Context } from "hono";
import type { AppVariables, CommandEnvelope, Env } from "../types";
import { can } from "../security/permissions";
import { escapeHtml, layout, money, qty, table } from "../views/html";
import { randomToken, sha256 } from "../security/crypto";
import { saleInvoiceHtml, saleInvoiceModel, saleInvoicePdfRows, toCsv, toPdf, toXlsx } from "../reports";

const transactions = new Hono<{ Bindings: Env; Variables: AppVariables }>();
type Row = Record<string, unknown>;
type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;
type TransactionKind = keyof typeof specs;

async function scopedDocument(c: AppContext, kind: TransactionKind, id: number, access: "read" | "write" = "read"): Promise<Row | null> {
  const spec = specs[kind];
  const companyId = c.get("user")!.activeCompanyId;
  let scope = "";
  const params: unknown[] = [id];
  if (companyId) {
    if (kind === "transfer" && access === "read") {
      scope = " AND (from_company_id=? OR to_company_id=?)";
      params.push(companyId, companyId);
    } else {
      scope = ` AND ${kind === "transfer" ? "from_company_id" : "company_id"}=?`;
      params.push(companyId);
    }
  }
  return c.env.DB.prepare(`SELECT * FROM ${spec.table} WHERE id=?${scope}`).bind(...params).first<Row>();
}

function requestedCompanyAllowed(c: AppContext, requested: unknown): boolean {
  const companyId = c.get("user")!.activeCompanyId;
  return !companyId || Number(requested) === companyId;
}

const specs = {
  purchase: {
    table: "purchases",
    id: "purchase_id",
    number: "bill_number",
    date: "bill_date",
    party: "supplier_id",
    partyTable: "suppliers",
    module: "purchase",
    command: "purchase",
    lineTable: "purchase_lines",
    rate: "rate_ten_thousandths",
  },
  sale: {
    table: "sales",
    id: "sale_id",
    number: "invoice_number",
    date: "invoice_date",
    party: "customer_id",
    partyTable: "customers",
    module: "sale",
    command: "sale",
    lineTable: "sale_lines",
    rate: "sale_rate_ten_thousandths",
  },
  transfer: {
    table: "inter_company_transfers",
    id: "transfer_id",
    number: "reference_number",
    date: "transfer_date",
    party: "to_company_id",
    partyTable: "companies",
    module: "transfer",
    command: "transfer",
    lineTable: "transfer_lines",
    rate: null,
  },
} as const;

function values(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  return Array.isArray(value)
    ? value.map(String)
    : value == null
      ? []
      : [String(value)];
}

function lines(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const itemIds = values(body, "item_id[]");
  const quantities = values(body, "quantity[]");
  const rates = values(body, "rate[]");
  const gst = values(body, "gst_percent[]");
  const remarks = values(body, "line_remarks[]");
  return itemIds
    .map((itemId, index) => ({
      itemId: Number.parseInt(itemId, 10),
      quantity: quantities[index] ?? "0",
      rate: rates[index] ?? "0",
      gstPercent: gst[index] ?? "0",
      remarks: remarks[index] ?? "",
    }))
    .filter(
      (line) => Number.isSafeInteger(line.itemId) && line.quantity !== "0",
    );
}

async function command(
  c: AppContext,
  type: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; result: Row; status: number }> {
  const user = c.get("user")!;
  const idempotencyKey = String(
    (await c.req.parseBody()).idempotency_key ??
      c.req.header("Idempotency-Key") ??
      randomToken(16),
  );
  const envelope: CommandEnvelope = {
    type,
    userId: user.id,
    companyId: Number(payload.companyId ?? user.activeCompanyId) || null,
    idempotencyKey,
    requestDigest: await sha256(JSON.stringify(payload)),
    payload,
  };
  const stub = c.env.ACCOUNTING.get(c.env.ACCOUNTING.idFromName("global"));
  const response = await stub.fetch("https://accounting.internal/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  return {
    ok: response.ok,
    result: await response.json<Row>(),
    status: response.status,
  };
}

function searchable(db: D1Database, table: string, columns: string, scope: string, scopeValues: unknown[], search: string, selected: number[]) {
  const ids = [...new Set(selected.filter((id) => Number.isSafeInteger(id) && id > 0))];
  const selectedSql = ids.length ? `id IN (${ids.map(() => "?").join(",")})` : "";
  const searchSql = search ? `(code LIKE ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE${selectedSql ? ` OR ${selectedSql}` : ""})` : "";
  const order = selectedSql ? `CASE WHEN ${selectedSql} THEN 0 ELSE 1 END,` : "";
  return db.prepare(`SELECT ${columns} FROM ${table} WHERE active=1${scope}${searchSql ? ` AND ${searchSql}` : ""} ORDER BY ${order}code LIMIT 100`)
    .bind(...scopeValues, ...(search ? [`${search}%`, `%${search}%`, ...ids] : []), ...(selectedSql ? ids : []));
}

async function options(db: D1Database, companyId: number | null, kind: TransactionKind, search: string, document: Row, existingLines: Row[], includeParty: boolean) {
  const sourceCompany = Number(kind === "transfer" ? document.from_company_id : document.company_id) || companyId || 0;
  const sourceBook = Number(kind === "transfer" ? document.from_stock_book_id : document.stock_book_id) || 0;
  const selectedItems = existingLines.map((line) => Number(line.item_id));
  const sourceScope = companyId ? " AND id=?" : "";
  const bookScope = companyId ? " AND company_id=?" : "";
  const statements = [
    searchable(db, "companies", "id,code,name", sourceScope, companyId ? [companyId] : [], search, [sourceCompany]),
    searchable(db, "stock_books", "id,code,name,company_id", bookScope, companyId ? [companyId] : [], search, [sourceBook]),
    searchable(db, "items", "id,code,name,unit", "", [], search, selectedItems),
  ];
  if (kind === "purchase" && includeParty) statements.push(searchable(db, "suppliers", "id,code,name", "", [], search, [Number(document.supplier_id)]));
  if (kind === "sale" && includeParty) statements.push(searchable(db, "customers", "id,code,name", "", [], search, [Number(document.customer_id)]));
  if (kind === "transfer") {
    statements.push(searchable(db, "companies", "id,code,name", "", [], search, [Number(document.to_company_id)]));
    statements.push(searchable(db, "stock_books", "id,code,name,company_id", "", [], search, [Number(document.to_stock_book_id)]));
  }
  const results = await db.batch(statements);
  return results.map((result) => (result.results ?? []) as Row[]);
}

const select = (name: string, rows: Row[], selected: unknown = null): string =>
  `<select name="${name}" required><option value="">Choose</option>${rows.map((row) => `<option value="${row.id}" ${Number(row.id) === Number(selected) ? "selected" : ""}>${escapeHtml(row.code)} — ${escapeHtml(row.name)}</option>`).join("")}</select>`;
const optionalSelect = (name: string, rows: Row[], selected: unknown = null): string =>
  `<select name="${name}"><option value="">Not specified</option>${rows.map((row) => `<option value="${row.id}" ${Number(row.id) === Number(selected) ? "selected" : ""}>${escapeHtml(row.code)} — ${escapeHtml(row.name)}</option>`).join("")}</select>`;
const transactionTypeSelect = (selected: unknown): string => {
  const value = String(selected ?? "GST").toUpperCase();
  return `<select name="document_type"><option value="GST" ${value === "GST" ? "selected" : ""}>GST</option><option value="CASH" ${value === "CASH" ? "selected" : ""}>CASH</option></select>`;
};

function lineEditor(items: Row[], existing: Row[] = []): string {
  const source = existing.length
    ? existing
    : [
        {
          item_id: "",
          quantity_milliunits: "",
          rate_ten_thousandths: "",
          gst_basis_points: "",
        },
      ];
  const rows = source
    .map(
      (line) =>
        `<tr data-line-row><td>${select("item_id[]", items, line.item_id)}</td><td><input name="quantity[]" value="${line.quantity_milliunits ? Number(line.quantity_milliunits) / 1000 : ""}" required></td><td><input name="rate[]" value="${line.rate_ten_thousandths ? Number(line.rate_ten_thousandths) / 10000 : "0"}"></td><td><input name="gst_percent[]" value="${line.gst_basis_points ? Number(line.gst_basis_points) / 100 : "0"}"></td><td><input name="line_remarks[]"><button type="button" data-remove-line aria-label="Remove line">Remove</button></td></tr>`,
    )
    .join("");
  return `<table id="lines" data-line-grid><thead><tr><th>Item</th><th>Quantity</th><th>Rate</th><th>GST %</th><th>Remarks</th></tr></thead><tbody>${rows}</tbody></table><button type="button" data-add-line>Add line</button>`;
}

async function listPage(c: AppContext, kind: keyof typeof specs) {
  const spec = specs[kind];
  const user = c.get("user")!;
  if (!can(user, spec.module)) return c.text("Forbidden", 403);
  const where = user.activeCompanyId
    ? kind === "transfer"
      ? " WHERE is_void=0 AND (from_company_id=? OR to_company_id=?)"
      : " WHERE is_void=0 AND company_id=?"
    : " WHERE is_void=0";
  const statement = c.env.DB.prepare(
    `SELECT id,${spec.number} number,${spec.date} date,${kind === "purchase" || kind === "sale" ? "grand_total_paise total,payment_status status" : "total_fifo_value_paise total,'ACTIVE' status"}${kind === "transfer" ? ",from_company_id,to_company_id,reason" : ""} FROM ${spec.table}${where} ORDER BY ${spec.date} DESC,id DESC LIMIT 100`,
  );
  const result = user.activeCompanyId
    ? await statement
        .bind(
          ...(kind === "transfer"
            ? [user.activeCompanyId, user.activeCompanyId]
            : [user.activeCompanyId]),
        )
        .all<Row>()
    : await statement.all<Row>();
  const rows = result.results.map((row) => {
    const ownsTransfer = kind !== "transfer" || !user.activeCompanyId || Number(row.from_company_id) === user.activeCompanyId;
    const editableTransfer = ownsTransfer && (kind !== "transfer" || row.reason !== "OPENING_PENDING_STOCK");
    return [
      escapeHtml(row.date),
      escapeHtml(row.number),
      `₹${money(row.total)}`,
      escapeHtml(row.status),
      `${editableTransfer && (can(user, spec.module, "edit") || can(user, spec.module, "create")) ? `<a href="/transactions/${kind}/${row.id}/edit">Edit</a> ` : ""}<a href="/transactions/${kind}/${row.id}/print">Print</a> <a href="/transactions/${kind}/${row.id}/export/csv">Export</a>${ownsTransfer && (can(user, spec.module, "edit") || can(user, spec.module, "deactivate")) ? ` <form class="inline-form" method="post" action="/transactions/${kind}/${row.id}/delete"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><button type="submit">Delete</button></form>` : ""}`,
    ];
  });
  const form = await documentForm(c, kind);
  return c.html(
    layout(
      kind[0]!.toUpperCase() + kind.slice(1),
      `${can(user, spec.module, "create") ? form : ""}${table(["Date", "Reference", "Total", "Status", "Actions"], rows)}`,
      user,
    ),
  );
}

async function documentForm(
  c: AppContext,
  kind: keyof typeof specs,
  document: Row = {},
  existingLines: Row[] = [],
  openingStock = false,
) {
  const user = c.get("user")!, search = (c.req.query("option_q") ?? "").trim(),
    optionSets = await options(c.env.DB, user.activeCompanyId, kind, search, document, existingLines, !openingStock),
    companies = optionSets[0] ?? [],
    books = optionSets[1] ?? [],
    items = optionSets[2] ?? [],
    suppliers = kind === "purchase" ? optionSets[3] ?? [] : [],
    customers = kind === "sale" ? optionSets[3] ?? [] : [],
    destinationCompanies = kind === "transfer" ? optionSets[3] ?? [] : [],
    destinationBooks = kind === "transfer" ? optionSets[4] ?? [] : [];
  const spec = specs[kind];
  const partyRows =
    kind === "purchase" ? suppliers : kind === "sale" ? customers : destinationCompanies;
  const companyValue =
    kind === "transfer" ? document.from_company_id : document.company_id;
  const partyField = openingStock ? "" : `<label>${kind === "purchase" ? "Supplier" : kind === "sale" ? "Customer" : "To company"}${select(spec.party, partyRows, document[spec.party])}</label>`;
  const dueDate = kind !== "transfer" && !openingStock
    ? `<label>Due date<input type="date" name="due_date" value="${escapeHtml(document.due_date ?? "")}"></label>`
    : "";
  const transferFields = kind === "transfer"
    ? `<label>Reason<input name="reason" value="${escapeHtml(document.reason ?? "")}"></label><label><input type="checkbox" name="mismatch_approved" value="1" ${document.mismatch_approved ? "checked" : ""}> Approve mismatch</label><label>Approval reason<textarea name="approval_reason">${escapeHtml(document.approval_reason ?? "")}</textarea></label>`
    : "";
  return `<form method="get" class="option-search"><label>Find options<input name="option_q" value="${escapeHtml(search)}" placeholder="Code or name"></label><button>Search</button></form><form method="post"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><input type="hidden" name="idempotency_key" value="${randomToken(16)}"><label>Company${select(kind === "transfer" ? "from_company_id" : "company_id", companies, companyValue ?? user.activeCompanyId)}</label><label>Stock book${select(kind === "transfer" ? "from_stock_book_id" : "stock_book_id", books, document.stock_book_id ?? document.from_stock_book_id)}</label>${partyField}${kind === "transfer" ? `<label>To stock book${select("to_stock_book_id", destinationBooks, document.to_stock_book_id)}</label>` : ""}<label>Reference<input name="reference_number" value="${escapeHtml(document[spec.number] ?? "")}" required></label><label>Date<input type="date" name="document_date" value="${escapeHtml(document[spec.date] ?? new Date().toISOString().slice(0, 10))}" required></label>${dueDate}${kind !== "transfer" && !openingStock ? `<label>Type${transactionTypeSelect(document.document_type ?? document.purchase_type ?? document.sale_type)}</label>` : ""}${transferFields}${lineEditor(items, existingLines)}<label>Remarks<textarea name="remarks">${escapeHtml(document.remarks ?? "")}</textarea></label><button>Save</button></form>`;
}

function pendingLineEditor(items: Row[], existing: Row[] = []): string {
  const source = existing.length ? existing : [{ item_id: "", quantity_milliunits: "" }];
  return `<table id="lines" data-line-grid><thead><tr><th>Item</th><th>Quantity</th><th></th></tr></thead><tbody>${source.map((line) => `<tr data-line-row><td>${select("item_id[]", items, line.item_id)}</td><td><input name="quantity[]" value="${line.quantity_milliunits ? Number(line.quantity_milliunits) / 1000 : ""}" required></td><td><button type="button" data-remove-line aria-label="Remove line">Remove</button></td></tr>`).join("")}</tbody></table><button type="button" data-add-line>Add line</button>`;
}

async function pendingStockForm(c: AppContext): Promise<string> {
  const user = c.get("user")!, search = (c.req.query("option_q") ?? "").trim();
  const optionSets = await options(c.env.DB, user.activeCompanyId, "transfer", search, {}, [], true);
  const companies = optionSets[0] ?? [], sourceBooks = optionSets[1] ?? [], items = optionSets[2] ?? [], destinationCompanies = optionSets[3] ?? [], destinationBooks = optionSets[4] ?? [];
  return `<form method="get" class="option-search"><label>Find options<input name="option_q" value="${escapeHtml(search)}" placeholder="Code or name"></label><button>Search</button></form><form method="post" action="/transactions/opening/pending-stock"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><input type="hidden" name="idempotency_key" value="${randomToken(16)}"><label>From company${select("from_company_id", companies, user.activeCompanyId)}</label><label>To company${select("to_company_id", destinationCompanies)}</label><label>From stock book (optional)${optionalSelect("from_stock_book_id", sourceBooks)}</label><label>To stock book (optional)${optionalSelect("to_stock_book_id", destinationBooks)}</label><label>Reference<input name="reference_number" required></label><label>Date<input type="date" name="transfer_date" value="${new Date().toISOString().slice(0,10)}" required></label>${pendingLineEditor(items)}<label>Remarks<textarea name="remarks"></textarea></label><button>Save</button></form>`;
}

async function openingBalanceForm(c:AppContext,section:"receivable"|"payable"|"advance-received"|"advance-paid"):Promise<string>{
  const user=c.get("user")!,search=(c.req.query("option_q")??"").trim(),customer=section==="receivable"||section==="advance-received",partyTable=customer?"customers":"suppliers";
  const companyScope=user.activeCompanyId?" AND id=?":"";
  const [companiesResult,partiesResult]=await c.env.DB.batch([
    searchable(c.env.DB,"companies","id,code,name",companyScope,user.activeCompanyId?[user.activeCompanyId]:[],search,[user.activeCompanyId??0]),
    searchable(c.env.DB,partyTable,"id,code,name","",[],search,[]),
  ]);
  const companies=(companiesResult?.results??[]) as Row[],parties=(partiesResult?.results??[]) as Row[],advance=section.startsWith("advance"),dateName=section==="receivable"?"invoice_date":section==="payable"?"bill_date":"payment_date";
  const transactionType=advance?"":`<label>${section==="receivable"?"Sale":"Purchase"} type<select name="${section==="receivable"?"sale_type":"purchase_type"}"><option value="GST">GST</option><option value="CASH">CASH</option></select></label>`;
  const due=advance?"":`<label>Due date<input type="date" name="due_date"></label>`;
  const mode=advance?`<label>Mode<select name="mode"><option>CASH</option><option>BANK</option><option>UPI</option><option>CHEQUE</option></select></label>`:"";
  return `<form method="get" class="option-search"><label>Find options<input name="option_q" value="${escapeHtml(search)}" placeholder="Code or name"></label><button>Search</button></form><form method="post" action="/transactions/opening/${section}"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><input type="hidden" name="idempotency_key" value="${randomToken(16)}"><label>Company${select("company_id",companies,user.activeCompanyId)}</label><label>${customer?"Customer":"Supplier"}${select(customer?"customer_id":"supplier_id",parties)}</label>${transactionType}<label>Reference<input name="reference_number"></label><label>Date<input type="date" name="${dateName}" value="${new Date().toISOString().slice(0,10)}" required></label>${due}${mode}<label>${advance?"Amount":"Pending amount"}<input name="${advance?"amount":"pending_amount"}" type="number" step="0.01" min="0.01" required></label><label>Remarks<textarea name="remarks"></textarea></label><button>Save</button></form>`;
}

for (const kind of Object.keys(specs) as Array<keyof typeof specs>) {
  transactions.get(`/${kind}`, (c) => listPage(c, kind));
  transactions.post(`/${kind}`, async (c) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const spec = specs[kind];
    const user = c.get("user")!;
    if (!can(user, spec.module, "create")) return c.text("Forbidden", 403);
    const payload: Record<string, unknown> = {
      companyId: Number(
        body[kind === "transfer" ? "from_company_id" : "company_id"],
      ),
      stockBookId: Number(
        body[kind === "transfer" ? "from_stock_book_id" : "stock_book_id"],
      ),
      referenceNumber: String(body.reference_number ?? ""),
      date: String(body.document_date ?? ""),
      documentType: String(body.document_type ?? "GST"),
      dueDate: String(body.due_date ?? "") || undefined,
      remarks: String(body.remarks ?? ""),
      lines: lines(body),
    };
    if (kind === "purchase") payload.supplierId = Number(body.supplier_id);
    if (kind === "sale") payload.customerId = Number(body.customer_id);
    if (kind === "transfer") {
      payload.toCompanyId = Number(body.to_company_id);
      payload.toStockBookId = Number(body.to_stock_book_id);
      payload.reason = String(body.reason ?? "");
      payload.mismatchApproved = body.mismatch_approved === "1";
      payload.approvalReason = String(body.approval_reason ?? "");
    }
    if (
      user.activeCompanyId &&
      Number(payload.companyId) !== user.activeCompanyId
    )
      return c.text("Forbidden", 403);
    if (!await c.env.DB.prepare("SELECT id FROM companies WHERE id=? AND active=1").bind(Number(payload.companyId)).first()) return c.text("Invalid or inactive company", 400);
    const result = await command(c, `${spec.command}.create`, payload);
    if (!result.ok) return c.json(result.result, result.status as 400);
    return c.redirect(`/transactions/${kind}`, 303);
  });
  transactions.get(`/${kind}/:id/edit`, async (c) => {
    const spec = specs[kind], id = Number(c.req.param("id"));
    if (!can(c.get("user"), spec.module, "edit") && !can(c.get("user"), spec.module, "create")) return c.text("Forbidden", 403);
    const doc = await scopedDocument(c, kind, id, "write");
    if (!doc) return c.notFound();
    if (kind === "transfer" && doc.reason === "OPENING_PENDING_STOCK")
      return c.text("Opening pending stock is read-only; delete and recreate it.", 409);
    const childId =
      kind === "transfer"
        ? "transfer_id"
        : kind === "purchase"
          ? "purchase_id"
          : "sale_id";
    const existing = (
      await c.env.DB.prepare(
        `SELECT * FROM ${spec.lineTable} WHERE ${childId}=? ORDER BY id`,
      )
        .bind(id)
        .all<Row>()
    ).results;
    return c.html(
      layout(
        `Edit ${kind}`,
        await documentForm(c, kind, doc, existing),
        c.get("user"),
      ),
    );
  });
  transactions.post(`/${kind}/:id/edit`, async (c) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const spec = specs[kind];
    const user = c.get("user")!;
    if (!can(user, spec.module, "edit") && !can(user, spec.module, "create")) return c.text("Forbidden", 403);
    const existing = await scopedDocument(c, kind, Number(c.req.param("id")), "write");
    if (!existing) return c.notFound();
    if (kind === "transfer" && existing.reason === "OPENING_PENDING_STOCK")
      return c.text("Opening pending stock is read-only; delete and recreate it.", 409);
    const requestedCompany = Number(body[kind === "transfer" ? "from_company_id" : "company_id"]);
    const existingCompany = Number(existing[kind === "transfer" ? "from_company_id" : "company_id"]);
    if (requestedCompany !== existingCompany || !requestedCompanyAllowed(c, requestedCompany)) return c.text("Forbidden", 403);
    const payload: Record<string, unknown> = {
      id: Number(c.req.param("id")),
      companyId: Number(
        body[kind === "transfer" ? "from_company_id" : "company_id"],
      ),
      stockBookId: Number(
        body[kind === "transfer" ? "from_stock_book_id" : "stock_book_id"],
      ),
      referenceNumber: String(body.reference_number ?? ""),
      date: String(body.document_date ?? ""),
      documentType: String(body.document_type ?? "GST"),
      dueDate: String(body.due_date ?? "") || undefined,
      remarks: String(body.remarks ?? ""),
      lines: lines(body),
    };
    if (kind === "purchase") payload.supplierId = Number(body.supplier_id);
    if (kind === "sale") payload.customerId = Number(body.customer_id);
    if (kind === "transfer") {
      payload.toCompanyId = Number(body.to_company_id);
      payload.toStockBookId = Number(body.to_stock_book_id);
      payload.reason = String(body.reason ?? "");
      payload.mismatchApproved = body.mismatch_approved === "1";
      payload.approvalReason = String(body.approval_reason ?? "");
    }
    const result = await command(c, `${spec.command}.edit`, payload);
    return result.ok
      ? c.redirect(`/transactions/${kind}`, 303)
      : c.json(result.result, result.status as 400);
  });
  transactions.post(`/${kind}/:id/delete`, async (c) => {
    const spec = specs[kind];
    if (!can(c.get("user"), spec.module, "deactivate") && !can(c.get("user"), spec.module, "edit")) return c.text("Forbidden", 403);
    const existing = await scopedDocument(c, kind, Number(c.req.param("id")), "write");
    if (!existing) return c.notFound();
    const result = await command(c, `${spec.command}.void`, {
        id: Number(c.req.param("id")),
        companyId: Number(existing[kind === "transfer" ? "from_company_id" : "company_id"]),
      });
    return result.ok
      ? c.redirect(`/transactions/${kind}`, 303)
      : c.json(result.result, result.status as 400);
  });
  transactions.get(`/${kind}/:id/print`, async (c) =>
    entryOutput(c, kind, Number(c.req.param("id")), "html"),
  );
  transactions.get(`/${kind}/:id/export/:fmt`, async (c) =>
    entryOutput(c, kind, Number(c.req.param("id")), c.req.param("fmt")),
  );
}

transactions.get("/sale/:id/view", async (c) =>
  entryOutput(c, "sale", Number(c.req.param("id")), "html"),
);

async function entryOutput(
  c: AppContext,
  kind: keyof typeof specs,
  id: number,
  fmt: string,
) {
  const spec = specs[kind];
  if (!can(c.get("user"), spec.module, "view")) return c.text("Forbidden", 403);
  if (!["html", "csv", "xlsx", "pdf"].includes(fmt)) return c.text("Unsupported format", 400);
  const doc = await scopedDocument(c, kind, id, "read");
  if (!doc) return c.notFound();
  const childId =
    kind === "transfer"
      ? "transfer_id"
      : kind === "purchase"
        ? "purchase_id"
        : "sale_id";
  const rows = (
    await c.env.DB.prepare(
      `SELECT l.*,i.code,i.name,i.unit,i.hsn FROM ${spec.lineTable} l JOIN items i ON i.id=l.item_id WHERE l.${childId}=? ORDER BY l.id`,
    )
      .bind(id)
      .all<Row>()
  ).results;
  if (kind === "sale") {
    const related=await c.env.DB.batch([
      c.env.DB.prepare("SELECT id,code,name,gst_number FROM companies WHERE id=?").bind(Number(doc.company_id)),
      c.env.DB.prepare("SELECT id,code,name,contact_person,gst_number,mobile,whatsapp,email,address,city,state FROM customers WHERE id=?").bind(Number(doc.customer_id)),
    ]);
    const company=related[0]?.results?.[0] as Row|undefined,customer=related[1]?.results?.[0] as Row|undefined;if(!company||!customer)return c.notFound();
    const invoice=saleInvoiceModel(doc,company,customer,rows);
    if(fmt==="html")return c.html(layout(`Tax Invoice ${doc.invoice_number}`,saleInvoiceHtml(invoice),c.get("user"),{scripts:c.req.path.endsWith("/print")?"<span hidden data-auto-print></span>":""}));
    if(fmt==="pdf")return new Response(toPdf(`Tax Invoice ${doc.invoice_number}`,saleInvoicePdfRows(invoice)),{headers:{"content-type":"application/pdf","content-disposition":`attachment; filename=sale-${id}.pdf`}});
  }
  if (fmt !== "html") {
    const exportRows = rows.map((r) => ({ Item: `${r.code} - ${r.name}`, quantity_milliunits: r.quantity_milliunits, value_paise: r.line_total_paise ?? r.fifo_value_paise ?? r.value_paise ?? 0 }));
    if (fmt === "xlsx") return new Response(toXlsx(exportRows, `${kind} ${doc[spec.number]}`), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename=${kind}-${id}.xlsx` } });
    if (fmt === "pdf") return new Response(toPdf(`${kind} ${doc[spec.number]}`, exportRows), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename=${kind}-${id}.pdf` } });
    return new Response(toCsv(exportRows), { headers: { "content-type": "text/csv;charset=utf-8", "content-disposition": `attachment; filename=${kind}-${id}.csv` } });
  }
  return c.html(
    layout(
      `${kind} ${doc[spec.number]}`,
      table(
        ["Item", "Quantity", "Value"],
        rows.map((r) => [
          escapeHtml(`${r.code} - ${r.name}`),
          qty(r.quantity_milliunits),
          money(r.line_total_paise ?? r.fifo_value_paise ?? r.value_paise),
        ]),
      ),
      c.get("user"),
    ),
  );
}

transactions.get("/reference/:kind", async (c) => {
  const kind = c.req.param("kind").toUpperCase();
  const module = ({ PURCHASE: "purchase", SALE: "sale", TRANSFER: "transfer", OPENING: "opening" } as const)[kind as "PURCHASE" | "SALE" | "TRANSFER" | "OPENING"];
  if (!module || !can(c.get("user"), module, "create")) return c.text("Forbidden", 403);
  const prefix =
    { PURCHASE: "PUR", SALE: "SAL", TRANSFER: "TRF", OPENING: "OPN" }[
      kind as "PURCHASE"
    ] ?? kind.slice(0, 3);
  return c.json({
    reference: `${prefix}-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`,
  });
});

transactions.get("/opening", async (c) => {
  const user = c.get("user")!;
  if (!can(user, "opening", "view")) return c.text("Forbidden", 403);
  const statements = [
    { sql: "SELECT id,opening_date date,reference_number ref,'stock' type FROM opening_stocks WHERE is_void=0", scope: "company_id=?" },
    { sql: "SELECT id,document_date date,document_number ref,'receivable' type FROM receivables WHERE is_opening=1", scope: "company_id=?" },
    { sql: "SELECT id,document_date date,document_number ref,'payable' type FROM payables WHERE is_opening=1", scope: "company_id=?" },
    { sql: "SELECT id,payment_date date,COALESCE(reference_number,id) ref,'advance' type FROM payments WHERE payment_type LIKE 'OPENING_ADVANCE%'", scope: "company_id=?" },
    { sql: "SELECT id,transfer_date date,reference_number ref,'pending stock' type FROM inter_company_transfers WHERE is_void=0 AND reason='OPENING_PENDING_STOCK'", scope: "(from_company_id=? OR to_company_id=?)" },
  ];
  const result = await c.env.DB.batch(
    statements.map((statement) =>
      c.env.DB.prepare(
        `${statement.sql}${user.activeCompanyId ? ` AND ${statement.scope}` : ""} ORDER BY date DESC LIMIT 100`,
      ).bind(...(user.activeCompanyId ? statement.scope.startsWith("(") ? [user.activeCompanyId, user.activeCompanyId] : [user.activeCompanyId] : [])),
    ),
  );
  const rows = result
    .flatMap((r) => (r.results ?? []) as Row[])
    .map((r) => {
      const type=String(r.type),lifecycle=type === "pending stock" ? "" : type;
      const actions=lifecycle ? `${can(user,"opening","edit")||can(user,"opening","create")?`<a href="/transactions/opening/${lifecycle}/${r.id}/edit">Edit</a> `:""}<a href="/transactions/opening/${lifecycle}/${r.id}/print">Print</a> <a href="/transactions/opening/${lifecycle}/${r.id}/export/csv">Export</a>${can(user,"opening","deactivate")||can(user,"opening","create")?` <form class="inline-form" method="post" action="/transactions/opening/${lifecycle}/${r.id}/delete"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><button type="submit">Delete</button></form>`:""}` : "";
      return [escapeHtml(r.date), escapeHtml(r.ref), escapeHtml(r.type), actions];
    });
  return c.html(
    layout(
      "Opening Entries",
      `${can(user,"opening","create")?'<nav class="inline-actions"><a href="/transactions/opening/stock/new">Opening stock</a><a href="/transactions/opening/pending-stock/new">Pending stock</a><a href="/transactions/opening/receivable/new">Receivable</a><a href="/transactions/opening/payable/new">Payable</a><a href="/transactions/opening/advance-received/new">Advance received</a><a href="/transactions/opening/advance-paid/new">Advance paid</a></nav>':""}${table(["Date", "Reference", "Type", "Actions"], rows)}`,
      user,
    ),
  );
});
transactions.get("/opening/stock/new", async (c) =>
  can(c.get("user"), "opening", "create") ? c.html(
    layout("Opening Stock", (await documentForm(c, "purchase", {}, [], true)).replace('<form method="post">', '<form method="post" action="/transactions/opening/stock">'), c.get("user")),
  ) : c.text("Forbidden", 403),
);
transactions.get("/opening/pending-stock/new", async (c) => can(c.get("user"), "opening", "create")
  ? c.html(layout("Pending Stock", await pendingStockForm(c), c.get("user")))
  : c.text("Forbidden", 403));
for(const section of ["receivable","payable","advance-received","advance-paid"] as const)transactions.get(`/opening/${section}/new`,async(c)=>can(c.get("user"),"opening","create")?c.html(layout(`Opening ${section.replaceAll("-"," ")}`,await openingBalanceForm(c,section),c.get("user"))):c.text("Forbidden",403));
transactions.post("/opening/:section", async (c) => {
  const user = c.get("user")!;
  if (!can(user, "opening", "create")) return c.text("Forbidden", 403);
  const body = (await c.req.parseBody()) as Record<string, unknown>,
    section = c.req.param("section"),
    payload: Record<string, unknown> = {
      companyId: Number(section === "pending-stock" ? body.from_company_id : body.company_id),
      stockBookId: body[section === "pending-stock" ? "from_stock_book_id" : "stock_book_id"] ? Number(body[section === "pending-stock" ? "from_stock_book_id" : "stock_book_id"]) : undefined,
      referenceNumber: String(body.reference_number ?? ""),
      date: String(body.transfer_date ?? body.document_date ?? body.opening_date ?? body.invoice_date ?? body.bill_date ?? body.payment_date ?? ""),
      remarks: String(body.remarks ?? ""),
      lines: section === "pending-stock" ? lines(body).map((line) => ({ itemId: line.itemId, quantity: line.quantity })) : lines(body),
    };
  if (section === "pending-stock") {
    payload.toCompanyId = Number(body.to_company_id);
    payload.toStockBookId = body.to_stock_book_id ? Number(body.to_stock_book_id) : undefined;
  }
  if (section === "receivable" || section === "payable") {
    payload.partyId = Number(body.party_id ?? body[section === "receivable" ? "customer_id" : "supplier_id"]);
    payload.amount = String(body.amount ?? body.pending_amount ?? "");
    payload.dueDate = body.due_date ? String(body.due_date) : undefined;
    payload.transactionType = String(body.transaction_type ?? body[section === "receivable" ? "sale_type" : "purchase_type"] ?? "GST");
  } else if (section === "advance-received" || section === "advance-paid") {
    payload.partyId = Number(body.party_id ?? body[section === "advance-received" ? "customer_id" : "supplier_id"]);
    payload.amount = String(body.amount ?? "");
    payload.mode = String(body.mode ?? "CASH");
  }
  const type = {
    stock: "opening.create",
    "pending-stock": "opening_pending.create",
    receivable: "opening_receivable.create",
    payable: "opening_payable.create",
    "advance-received": "opening_advance_received.create",
    "advance-paid": "opening_advance_paid.create",
  }[section];
  if (!type) return c.notFound();
  if (!Number.isSafeInteger(Number(payload.companyId)) || Number(payload.companyId) <= 0) return c.text("Choose an active company", 400);
  if (!requestedCompanyAllowed(c, payload.companyId)) return c.text("Forbidden", 403);
  if (!await c.env.DB.prepare("SELECT id FROM companies WHERE id=? AND active=1").bind(Number(payload.companyId)).first()) return c.text("Invalid or inactive company", 400);
  const result = await command(c, type, payload);
  return result.ok
    ? c.redirect("/transactions/opening", 303)
    : c.json(result.result, result.status as 400);
});

const openingKinds = {
  stock: {
    table: "opening_stocks",
    entity: "opening",
    date: "opening_date",
    number: "reference_number",
    lineTable: "opening_stock_lines",
    parent: "opening_stock_id",
  },
  receivable: {
    table: "receivables",
    entity: "opening_receivable",
    date: "document_date",
    number: "document_number",
    lineTable: null,
    parent: null,
  },
  payable: {
    table: "payables",
    entity: "opening_payable",
    date: "document_date",
    number: "document_number",
    lineTable: null,
    parent: null,
  },
  advance: {
    table: "payments",
    entity: "opening_advance",
    date: "payment_date",
    number: "reference_number",
    lineTable: null,
    parent: null,
  },
} as const;

for (const [openingKind, openingSpec] of Object.entries(openingKinds)) {
  const lifecycleScope = openingKind === "advance" ? " AND payment_type LIKE 'OPENING_ADVANCE%'" : openingKind === "receivable" || openingKind === "payable" ? " AND is_opening=1" : "";
  transactions.get(`/opening/${openingKind}/:id/edit`, async (c) => {
    if (!can(c.get("user"), "opening", "edit") && !can(c.get("user"), "opening", "create")) return c.text("Forbidden", 403);
    const id = Number(c.req.param("id"));
    const companyId = c.get("user")!.activeCompanyId;
    const row = await c.env.DB.prepare(
      `SELECT * FROM ${openingSpec.table} WHERE id=?${lifecycleScope}${companyId ? " AND company_id=?" : ""}`,
    )
      .bind(id, ...(companyId ? [companyId] : []))
      .first<Row>();
    if (!row) return c.notFound();
    if (openingKind === "stock") {
      const childRows = await c.env.DB.prepare(
        "SELECT * FROM opening_stock_lines WHERE opening_stock_id=? ORDER BY id",
      )
        .bind(id)
        .all<Row>();
      return c.html(
        layout(
          "Edit Opening Stock",
          await documentForm(c, "purchase", { ...row, bill_number: row.reference_number, bill_date: row.opening_date }, childRows.results, true),
          c.get("user"),
        ),
      );
    }
    const user = c.get("user")!;
    const amount = Number(row.total_amount_paise ?? 0) / 100;
    return c.html(
      layout(
        `Edit Opening ${openingKind}`,
        `<form method="post"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><input type="hidden" name="idempotency_key" value="${randomToken(16)}"><input type="hidden" name="company_id" value="${escapeHtml(row.company_id)}"><label>Document<input name="reference_number" value="${escapeHtml(row[openingSpec.number])}" required></label><label>Date<input type="date" name="document_date" value="${escapeHtml(row[openingSpec.date])}"></label><label>Amount<input name="amount" value="${amount}" required></label><label>Remarks<textarea name="remarks">${escapeHtml(row.remarks ?? "")}</textarea></label><button>Save</button></form>`,
        user,
      ),
    );
  });

  transactions.post(`/opening/${openingKind}/:id/edit`, async (c) => {
    if (!can(c.get("user"), "opening", "edit") && !can(c.get("user"), "opening", "create")) return c.text("Forbidden", 403);
    const body = (await c.req.parseBody()) as Row;
    const companyId = c.get("user")!.activeCompanyId;
    const existing = await c.env.DB.prepare(`SELECT * FROM ${openingSpec.table} WHERE id=?${lifecycleScope}${companyId ? " AND company_id=?" : ""}`).bind(Number(c.req.param("id")), ...(companyId ? [companyId] : [])).first<Row>();
    if (!existing) return c.notFound();
    if (body.company_id && Number(body.company_id) !== Number(existing.company_id)) return c.text("Forbidden", 403);
    const payload: Row = {
      id: Number(c.req.param("id")),
      companyId: Number(body.company_id ?? existing.company_id),
      referenceNumber: String(body.reference_number ?? ""),
      date: String(body.document_date ?? ""),
      amount: String(body.amount ?? ""),
      remarks: String(body.remarks ?? ""),
      lines: lines(body),
      stockBookId: Number(body.stock_book_id ?? existing.stock_book_id),
      partyId: Number(body.party_id ?? body.customer_id ?? body.supplier_id ?? existing.customer_id ?? existing.supplier_id),
      mode: String(body.mode ?? existing.mode ?? "CASH"),
      transactionType: String(body.transaction_type ?? existing.transaction_type ?? "GST"),
    };
    const entity = openingKind === "advance" ? (existing.payment_type === "OPENING_ADVANCE_PAID" ? "opening_advance_paid" : "opening_advance_received") : openingSpec.entity;
    const result = await command(c, `${entity}.edit`, payload);
    return result.ok
      ? c.redirect("/transactions/opening", 303)
      : c.json(result.result, result.status as 400);
  });

  transactions.post(`/opening/${openingKind}/:id/delete`, async (c) => {
    if (!can(c.get("user"), "opening", "deactivate") && !can(c.get("user"), "opening", "create")) return c.text("Forbidden", 403);
    const companyId = c.get("user")!.activeCompanyId;
    const existing = await c.env.DB.prepare(`SELECT company_id${openingKind === "advance" ? ",payment_type" : ""} FROM ${openingSpec.table} WHERE id=?${lifecycleScope}${companyId ? " AND company_id=?" : ""}`).bind(Number(c.req.param("id")), ...(companyId ? [companyId] : [])).first<Row>();
    if (!existing) return c.notFound();
    const entity = openingKind === "advance" ? (existing?.payment_type === "OPENING_ADVANCE_PAID" ? "opening_advance_paid" : "opening_advance_received") : openingSpec.entity;
    const commandType = openingKind === "stock" ? "opening.void" : `${entity}.delete`;
    const result = await command(c, commandType, {
      id: Number(c.req.param("id")),
      companyId: Number(existing.company_id),
    });
    return result.ok
      ? c.redirect("/transactions/opening", 303)
      : c.json(result.result, result.status as 400);
  });

  for (const mode of ["print", "export/:fmt"] as const) {
    transactions.get(`/opening/${openingKind}/:id/${mode}`, async (c) => {
      const isExport = c.req.path.includes("/export/");
      if (!can(c.get("user"), "opening", "view")) return c.text("Forbidden", 403);
      const format = c.req.param("fmt");
      if (isExport && !["csv", "xlsx", "pdf"].includes(format)) return c.text("Unsupported format", 400);
      const id = Number(c.req.param("id"));
      const companyId = c.get("user")!.activeCompanyId;
      const row = await c.env.DB.prepare(
        `SELECT * FROM ${openingSpec.table} WHERE id=?${lifecycleScope}${companyId ? " AND company_id=?" : ""}`,
      )
        .bind(id, ...(companyId ? [companyId] : []))
        .first<Row>();
      if (!row) return c.notFound();
      let detail: Row[] = [];
      if (openingSpec.lineTable && openingSpec.parent)
        detail = (
          await c.env.DB.prepare(
            `SELECT l.*,i.code,i.name FROM ${openingSpec.lineTable} l JOIN items i ON i.id=l.item_id WHERE l.${openingSpec.parent}=? ORDER BY l.id`,
          )
            .bind(id)
            .all<Row>()
        ).results;
      const exportRows = [{ Reference: row[openingSpec.number] ?? id, Date: row[openingSpec.date] ?? "", amount_paise: row.total_amount_paise ?? row.value_paise ?? 0 }];
      if (isExport) {
        if (format === "xlsx") return new Response(toXlsx(exportRows, `Opening ${openingKind}`), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename=opening-${openingKind}-${id}.xlsx` } });
        if (format === "pdf") return new Response(toPdf(`Opening ${openingKind} ${row[openingSpec.number] ?? id}`, exportRows), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename=opening-${openingKind}-${id}.pdf` } });
        return new Response(toCsv(exportRows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename=opening-${openingKind}-${id}.csv` } });
      }
      return c.html(
        layout(
          `Opening ${openingKind} ${row[openingSpec.number] ?? id}`,
          detail.length
            ? table(
                ["Item", "Quantity", "Value"],
                detail.map((item) => [
                  escapeHtml(`${item.code} - ${item.name}`),
                  qty(item.quantity_milliunits),
                  money(item.value_paise),
                ]),
              )
            : table(
                ["Date", "Amount"],
                [
                  [
                    escapeHtml(row[openingSpec.date]),
                    money(row.total_amount_paise),
                  ],
                ],
              ),
          c.get("user"),
        ),
      );
    });
  }
}

export default transactions;
