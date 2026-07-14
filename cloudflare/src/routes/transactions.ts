import { Hono, type Context } from "hono";
import type { AppVariables, CommandEnvelope, Env } from "../types";
import { can } from "../security/permissions";
import { escapeHtml, layout, money, qty, table } from "../views/html";
import { randomToken, sha256 } from "../security/crypto";

const transactions = new Hono<{ Bindings: Env; Variables: AppVariables }>();
type Row = Record<string, unknown>;
type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

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

async function options(db: D1Database, companyId: number | null) {
  const results = await db.batch([
    companyId
      ? db
          .prepare(
            "SELECT id,code,name FROM companies WHERE active=1 AND id=? ORDER BY code",
          )
          .bind(companyId)
      : db.prepare(
          "SELECT id,code,name FROM companies WHERE active=1 ORDER BY code",
        ),
    companyId
      ? db
          .prepare(
            "SELECT id,code,name,company_id FROM stock_books WHERE active=1 AND company_id=? ORDER BY code",
          )
          .bind(companyId)
      : db.prepare(
          "SELECT id,code,name,company_id FROM stock_books WHERE active=1 ORDER BY code",
        ),
    db.prepare(
      "SELECT id,code,name,unit FROM items WHERE active=1 ORDER BY code LIMIT 500",
    ),
    db.prepare(
      "SELECT id,code,name FROM suppliers WHERE active=1 ORDER BY code LIMIT 500",
    ),
    db.prepare(
      "SELECT id,code,name FROM customers WHERE active=1 ORDER BY code LIMIT 500",
    ),
  ]);
  return results.map((result) => (result.results ?? []) as Row[]);
}

const select = (name: string, rows: Row[], selected: unknown = null): string =>
  `<select name="${name}" required><option value="">Choose</option>${rows.map((row) => `<option value="${row.id}" ${Number(row.id) === Number(selected) ? "selected" : ""}>${escapeHtml(row.code)} — ${escapeHtml(row.name)}</option>`).join("")}</select>`;

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
        `<tr><td>${select("item_id[]", items, line.item_id)}</td><td><input name="quantity[]" value="${line.quantity_milliunits ? Number(line.quantity_milliunits) / 1000 : ""}" required></td><td><input name="rate[]" value="${line.rate_ten_thousandths ? Number(line.rate_ten_thousandths) / 10000 : "0"}"></td><td><input name="gst_percent[]" value="${line.gst_basis_points ? Number(line.gst_basis_points) / 100 : "0"}"></td><td><input name="line_remarks[]"></td></tr>`,
    )
    .join("");
  return `<table id="lines"><thead><tr><th>Item</th><th>Quantity</th><th>Rate</th><th>GST %</th><th>Remarks</th></tr></thead><tbody>${rows}</tbody></table><button type="button" data-add-line>Add line</button>`;
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
    `SELECT id,${spec.number} number,${spec.date} date,${kind === "purchase" || kind === "sale" ? "grand_total_paise total,payment_status status" : "total_fifo_value_paise total,'ACTIVE' status"} FROM ${spec.table}${where} ORDER BY ${spec.date} DESC,id DESC LIMIT 100`,
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
  const rows = result.results.map((row) => [
    escapeHtml(row.date),
    escapeHtml(row.number),
    `₹${money(row.total)}`,
    escapeHtml(row.status),
    `<a href="/transactions/${kind}/${row.id}/edit">Edit</a> <a href="/transactions/${kind}/${row.id}/print">Print</a>`,
  ]);
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
) {
  const user = c.get("user")!,
    optionSets = await options(c.env.DB, user.activeCompanyId),
    companies = optionSets[0] ?? [],
    books = optionSets[1] ?? [],
    items = optionSets[2] ?? [],
    suppliers = optionSets[3] ?? [],
    customers = optionSets[4] ?? [];
  const spec = specs[kind];
  const partyRows =
    kind === "purchase" ? suppliers : kind === "sale" ? customers : companies;
  const companyValue =
    kind === "transfer" ? document.from_company_id : document.company_id;
  return `<form method="post"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><input type="hidden" name="idempotency_key" value="${randomToken(16)}"><label>Company${select(kind === "transfer" ? "from_company_id" : "company_id", companies, companyValue ?? user.activeCompanyId)}</label><label>Stock book${select(kind === "transfer" ? "from_stock_book_id" : "stock_book_id", books, document.stock_book_id ?? document.from_stock_book_id)}</label><label>${kind === "purchase" ? "Supplier" : kind === "sale" ? "Customer" : "To company"}${select(spec.party, partyRows, document[spec.party])}</label>${kind === "transfer" ? `<label>To stock book${select("to_stock_book_id", books, document.to_stock_book_id)}</label>` : ""}<label>Reference<input name="reference_number" value="${escapeHtml(document[spec.number] ?? "")}" required></label><label>Date<input type="date" name="document_date" value="${escapeHtml(document[spec.date] ?? new Date().toISOString().slice(0, 10))}" required></label>${kind !== "transfer" ? '<label>Type<select name="document_type"><option>GST</option><option>CASH</option></select></label>' : ""}${lineEditor(items, existingLines)}<label>Remarks<textarea name="remarks">${escapeHtml(document.remarks ?? "")}</textarea></label><button>Save</button></form>`;
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
      remarks: String(body.remarks ?? ""),
      lines: lines(body),
    };
    if (kind === "purchase") payload.supplierId = Number(body.supplier_id);
    if (kind === "sale") payload.customerId = Number(body.customer_id);
    if (kind === "transfer") {
      payload.toCompanyId = Number(body.to_company_id);
      payload.toStockBookId = Number(body.to_stock_book_id);
    }
    if (
      user.activeCompanyId &&
      Number(payload.companyId) !== user.activeCompanyId &&
      !(
        kind === "transfer" &&
        Number(payload.toCompanyId) === user.activeCompanyId
      )
    )
      return c.text("Forbidden", 403);
    const result = await command(c, `${spec.command}.create`, payload);
    if (!result.ok) return c.json(result.result, result.status as 400);
    return c.redirect(`/transactions/${kind}`, 303);
  });
  transactions.get(`/${kind}/:id/edit`, async (c) => {
    const spec = specs[kind],
      id = Number(c.req.param("id")),
      doc = await c.env.DB.prepare(`SELECT * FROM ${spec.table} WHERE id=?`)
        .bind(id)
        .first<Row>();
    if (!doc) return c.notFound();
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
      remarks: String(body.remarks ?? ""),
      lines: lines(body),
    };
    if (kind === "purchase") payload.supplierId = Number(body.supplier_id);
    if (kind === "sale") payload.customerId = Number(body.customer_id);
    if (kind === "transfer") {
      payload.toCompanyId = Number(body.to_company_id);
      payload.toStockBookId = Number(body.to_stock_book_id);
    }
    const result = await command(c, `${spec.command}.edit`, payload);
    return result.ok
      ? c.redirect(`/transactions/${kind}`, 303)
      : c.json(result.result, result.status as 400);
  });
  transactions.post(`/${kind}/:id/delete`, async (c) => {
    const spec = specs[kind],
      result = await command(c, `${spec.command}.void`, {
        id: Number(c.req.param("id")),
        companyId: c.get("user")!.activeCompanyId,
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
  const spec = specs[kind],
    doc = await c.env.DB.prepare(`SELECT * FROM ${spec.table} WHERE id=?`)
      .bind(id)
      .first<Row>();
  if (!doc) return c.notFound();
  const childId =
    kind === "transfer"
      ? "transfer_id"
      : kind === "purchase"
        ? "purchase_id"
        : "sale_id";
  const rows = (
    await c.env.DB.prepare(
      `SELECT l.*,i.code,i.name FROM ${spec.lineTable} l JOIN items i ON i.id=l.item_id WHERE l.${childId}=? ORDER BY l.id`,
    )
      .bind(id)
      .all<Row>()
  ).results;
  if (fmt === "csv" || fmt === "xlsx") {
    const csv = [
      "Item,Quantity,Value",
      ...rows.map(
        (r) =>
          `${JSON.stringify(`${r.code} - ${r.name}`)},${Number(r.quantity_milliunits) / 1000},${Number(r.line_total_paise ?? r.fifo_value_paise ?? r.value_paise ?? 0) / 100}`,
      ),
    ].join("\r\n");
    return new Response(csv, {
      headers: {
        "content-type": "text/csv;charset=utf-8",
        "content-disposition": `attachment; filename=${kind}-${id}.csv`,
      },
    });
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
  const statements = [
    "SELECT id,opening_date date,reference_number ref,'stock' type FROM opening_stocks WHERE is_void=0",
    "SELECT id,document_date date,document_number ref,'receivable' type FROM receivables WHERE is_opening=1",
    "SELECT id,document_date date,document_number ref,'payable' type FROM payables WHERE is_opening=1",
    "SELECT id,payment_date date,COALESCE(reference_number,id) ref,'advance' type FROM payments WHERE payment_type LIKE 'OPENING_ADVANCE%'",
  ];
  const result = await c.env.DB.batch(
    statements.map((sql) =>
      c.env.DB.prepare(
        `${sql}${user.activeCompanyId ? " AND company_id=?" : ""} ORDER BY date DESC LIMIT 100`,
      ).bind(...(user.activeCompanyId ? [user.activeCompanyId] : [])),
    ),
  );
  const rows = result
    .flatMap((r) => (r.results ?? []) as Row[])
    .map((r) => [escapeHtml(r.date), escapeHtml(r.ref), escapeHtml(r.type)]);
  return c.html(
    layout(
      "Opening Entries",
      `<p><a href="/transactions/opening/stock/new">New opening stock</a></p>${table(["Date", "Reference", "Type"], rows)}`,
      user,
    ),
  );
});
transactions.get("/opening/stock/new", async (c) =>
  c.html(
    layout("Opening Stock", (await documentForm(c, "purchase")).replace('<form method="post">', '<form method="post" action="/transactions/opening/stock">'), c.get("user")),
  ),
);
transactions.post("/opening/:section", async (c) => {
  const body = (await c.req.parseBody()) as Record<string, unknown>,
    section = c.req.param("section"),
    payload: Record<string, unknown> = {
      companyId: Number(body.company_id),
      stockBookId: Number(body.stock_book_id),
      referenceNumber: String(body.reference_number ?? ""),
      date: String(body.document_date ?? body.opening_date ?? ""),
      remarks: String(body.remarks ?? ""),
      lines: lines(body),
    };
  const type = {
    stock: "opening.create",
    "pending-stock": "opening_pending.create",
    receivable: "opening_receivable.create",
    payable: "opening_payable.create",
    "advance-received": "opening_advance_received.create",
    "advance-paid": "opening_advance_paid.create",
  }[section];
  if (!type) return c.notFound();
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
  transactions.get(`/opening/${openingKind}/:id/edit`, async (c) => {
    const id = Number(c.req.param("id"));
    const row = await c.env.DB.prepare(
      `SELECT * FROM ${openingSpec.table} WHERE id=?`,
    )
      .bind(id)
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
          await documentForm(c, "purchase", row, childRows.results),
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
    const body = (await c.req.parseBody()) as Row;
    const payload: Row = {
      id: Number(c.req.param("id")),
      companyId: Number(body.company_id),
      referenceNumber: String(body.reference_number ?? ""),
      date: String(body.document_date ?? ""),
      amount: String(body.amount ?? ""),
      remarks: String(body.remarks ?? ""),
      lines: lines(body),
      stockBookId: Number(body.stock_book_id),
    };
    const result = await command(c, `${openingSpec.entity}.edit`, payload);
    return result.ok
      ? c.redirect("/transactions/opening", 303)
      : c.json(result.result, result.status as 400);
  });

  transactions.post(`/opening/${openingKind}/:id/delete`, async (c) => {
    const result = await command(c, `${openingSpec.entity}.delete`, {
      id: Number(c.req.param("id")),
      companyId: c.get("user")!.activeCompanyId,
    });
    return result.ok
      ? c.redirect("/transactions/opening", 303)
      : c.json(result.result, result.status as 400);
  });

  for (const mode of ["print", "export/:fmt"] as const) {
    transactions.get(`/opening/${openingKind}/:id/${mode}`, async (c) => {
      const id = Number(c.req.param("id"));
      const row = await c.env.DB.prepare(
        `SELECT * FROM ${openingSpec.table} WHERE id=?`,
      )
        .bind(id)
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
      const csv = [
        `Reference,Date,Amount`,
        `${row[openingSpec.number] ?? id},${row[openingSpec.date] ?? ""},${Number(row.total_amount_paise ?? row.value_paise ?? 0) / 100}`,
      ].join("\r\n");
      if (c.req.path.includes("/export/"))
        return new Response(csv, {
          headers: {
            "content-type": "text/csv",
            "content-disposition": `attachment; filename=opening-${openingKind}-${id}.csv`,
          },
        });
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
