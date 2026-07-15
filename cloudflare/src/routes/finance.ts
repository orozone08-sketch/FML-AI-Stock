import { Hono, type Context } from "hono";
import type { AppVariables, CommandEnvelope, Env } from "../types";
import { can } from "../security/permissions";
import { escapeHtml, layout, money, table } from "../views/html";
import { randomToken, sha256 } from "../security/crypto";

const finance = new Hono<{ Bindings: Env; Variables: AppVariables }>();
type Row = Record<string, unknown>;
type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

async function send(c: AppContext, type: string, payload: Row) {
  const user = c.get("user")!,
    body = await c.req.parseBody();
  const envelope: CommandEnvelope = {
    type,
    userId: user.id,
    companyId: Number(payload.companyId) || user.activeCompanyId,
    idempotencyKey: String(body.idempotency_key ?? randomToken(16)),
    requestDigest: await sha256(JSON.stringify(payload)),
    payload,
  };
  const response = await c.env.ACCOUNTING.get(
    c.env.ACCOUNTING.idFromName("global"),
  ).fetch("https://accounting.internal/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await response.json<Row>(),
  };
}

async function paymentForm(
  c: AppContext,
  kind: "customer" | "supplier",
  row: Row = {},
) {
  const user = c.get("user")!,
    company = user.activeCompanyId;
  const parties = await c.env.DB.prepare(
    `SELECT id,code,name FROM ${kind === "customer" ? "customers" : "suppliers"} WHERE active=1 ORDER BY code LIMIT 500`,
  ).all<Row>();
  const targets = await c.env.DB.prepare(
    `SELECT id,document_number,balance_amount_paise FROM ${kind === "customer" ? "receivables" : "payables"} WHERE balance_amount_paise>0${company ? " AND company_id=?" : ""} ORDER BY due_date,document_date,id LIMIT 500`,
  )
    .bind(...(company ? [company] : []))
    .all<Row>();
  const options = (rows: Row[], label: (r: Row) => string, selected: unknown) =>
    rows
      .map(
        (r) =>
          `<option value="${r.id}" ${Number(r.id) === Number(selected) ? "selected" : ""}>${escapeHtml(label(r))}</option>`,
      )
      .join("");
  return `<form method="post"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><input type="hidden" name="idempotency_key" value="${randomToken(16)}"><input type="hidden" name="company_id" value="${company ?? row.company_id ?? ""}"><label>${kind}<select name="party_id" required>${options(parties.results, (r) => `${r.code} — ${r.name}`, row[kind === "customer" ? "customer_id" : "supplier_id"])}</select></label><label>Preferred document<select name="target_id"><option value="">Allocate oldest first</option>${options(targets.results, (r) => `${r.document_number} — ₹${money(r.balance_amount_paise)}`, "")}</select></label><label>Date<input type="date" name="payment_date" value="${escapeHtml(row.payment_date ?? new Date().toISOString().slice(0, 10))}" required></label><label>Mode<select name="mode"><option>CASH</option><option>BANK</option><option>UPI</option><option>CHEQUE</option><option>RTGS</option><option>NEFT</option><option>OTHER</option></select></label><label>Reference<input name="reference_number" value="${escapeHtml(row.reference_number ?? "")}"></label><label>Amount<input name="amount" value="${row.total_amount_paise ? Number(row.total_amount_paise) / 100 : ""}" required></label><label>Remarks<textarea name="remarks">${escapeHtml(row.remarks ?? "")}</textarea></label><button>Save</button></form>`;
}

finance.get("/payments", async (c) => {
  const user = c.get("user")!;
  if (!can(user, "payments")) return c.text("Forbidden", 403);
  const scoped = user.activeCompanyId ? " WHERE p.company_id=?" : "";
  const result = await c.env.DB.prepare(
    `SELECT p.id,p.payment_date,p.payment_type,p.reference_number,p.total_amount_paise,p.allocated_amount_paise,p.unallocated_amount_paise,COALESCE(c.name,s.name) party FROM payments p LEFT JOIN customers c ON c.id=p.customer_id LEFT JOIN suppliers s ON s.id=p.supplier_id${scoped} ORDER BY p.payment_date DESC,p.id DESC LIMIT 100`,
  )
    .bind(...(user.activeCompanyId ? [user.activeCompanyId] : []))
    .all<Row>();
  const rows = result.results.map((r) => [
    escapeHtml(r.payment_date),
    escapeHtml(r.payment_type),
    escapeHtml(r.party),
    `₹${money(r.total_amount_paise)}`,
    `₹${money(r.unallocated_amount_paise)}`,
    `<a href="/finance/payments/${r.id}/edit">Edit</a> <a href="/finance/payments/${r.id}/print">Print</a>`,
  ]);
  return c.html(
    layout(
      "Payments",
      `${can(user, "payments", "create") ? `<details><summary>Customer receipt</summary>${await paymentForm(c, "customer")}</details><details><summary>Supplier payment</summary>${await paymentForm(c, "supplier")}</details>` : ""}${table(["Date", "Type", "Party", "Amount", "Advance", "Actions"], rows)}`,
      user,
    ),
  );
});

async function create(c: AppContext, kind: "customer" | "supplier") {
  const body = (await c.req.parseBody()) as Row,
    user = c.get("user")!;
  if (!can(user, "payments", "create")) return c.text("Forbidden", 403);
  const payload = {
    companyId: Number(body.company_id ?? user.activeCompanyId),
    paymentType: kind === "customer" ? "CUSTOMER_RECEIPT" : "SUPPLIER_PAYMENT",
    partyId: Number(body.party_id),
    date: String(body.payment_date ?? ""),
    mode: String(body.mode ?? "CASH"),
    referenceNumber: String(body.reference_number ?? ""),
    amount: String(body.amount ?? ""),
    preferredTargetId: body.target_id ? Number(body.target_id) : undefined,
    remarks: String(body.remarks ?? ""),
  };
  const result = await send(c, "payment.create", payload);
  return result.ok
    ? c.redirect("/finance/payments", 303)
    : c.json(result.body, result.status as 400);
}
finance.post("/payments/customer-receipt", (c) => create(c, "customer"));
finance.post("/payments/supplier-payment", (c) => create(c, "supplier"));
// The legacy payments page posts directly to these paths; accept a discriminator for parity.
finance.post("/payments", async (c) => {
  const body = (await c.req.parseBody()) as Row;
  return create(
    c,
    String(body.party_type ?? "").toUpperCase() === "SUPPLIER"
      ? "supplier"
      : "customer",
  );
});
finance.get("/payments/:id/edit", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM payments WHERE id=?")
    .bind(Number(c.req.param("id")))
    .first<Row>();
  if (!row) return c.notFound();
  return c.html(
    layout(
      "Edit Payment",
      await paymentForm(c, row.customer_id ? "customer" : "supplier", row),
      c.get("user"),
    ),
  );
});
finance.post("/payments/:id/edit", async (c) => {
  const body = (await c.req.parseBody()) as Row,
    row = await c.env.DB.prepare("SELECT payment_type FROM payments WHERE id=?")
      .bind(Number(c.req.param("id")))
      .first<Row>();
  if (!row) return c.notFound();
  const kind = String(row.payment_type).includes("CUSTOMER")
    ? "customer"
    : "supplier";
  const payload = {
    id: Number(c.req.param("id")),
    companyId: Number(body.company_id),
    paymentType: row.payment_type,
    partyId: Number(body.party_id),
    date: String(body.payment_date),
    mode: String(body.mode),
    referenceNumber: String(body.reference_number ?? ""),
    amount: String(body.amount),
    preferredTargetId: body.target_id ? Number(body.target_id) : undefined,
    remarks: String(body.remarks ?? ""),
  };
  const result = await send(c, "payment.edit", payload);
  return result.ok
    ? c.redirect("/finance/payments", 303)
    : c.json(result.body, result.status as 400);
});
finance.post("/payments/:id/delete", async (c) => {
  const result = await send(c, "payment.delete", {
    id: Number(c.req.param("id")),
    companyId: c.get("user")!.activeCompanyId,
  });
  return result.ok
    ? c.redirect("/finance/payments", 303)
    : c.json(result.body, result.status as 400);
});
finance.get("/payments/:id/print", async (c) => {
  const r = await c.env.DB.prepare("SELECT * FROM payments WHERE id=?")
    .bind(Number(c.req.param("id")))
    .first<Row>();
  if (!r) return c.notFound();
  return c.html(
    layout(
      `Payment ${r.reference_number ?? r.id}`,
      table(
        ["Date", "Type", "Amount", "Allocated", "Advance"],
        [
          [
            escapeHtml(r.payment_date),
            escapeHtml(r.payment_type),
            money(r.total_amount_paise),
            money(r.allocated_amount_paise),
            money(r.unallocated_amount_paise),
          ],
        ],
      ),
      c.get("user"),
    ),
  );
});
finance.get("/payments/:id/export/:fmt", async (c) => {
  const r = await c.env.DB.prepare(
    "SELECT id,payment_date,payment_type,reference_number,total_amount_paise,allocated_amount_paise,unallocated_amount_paise FROM payments WHERE id=?",
  )
    .bind(Number(c.req.param("id")))
    .first<Row>();
  if (!r) return c.notFound();
  return new Response(
    `Date,Type,Reference,Total,Allocated,Advance\r\n${r.payment_date},${r.payment_type},${r.reference_number ?? ""},${Number(r.total_amount_paise) / 100},${Number(r.allocated_amount_paise) / 100},${Number(r.unallocated_amount_paise) / 100}`,
    {
      headers: {
        "content-type": "text/csv",
        "content-disposition": `attachment; filename=payment-${r.id}.csv`,
      },
    },
  );
});

export default finance;
