import { Hono, type Context } from "hono";
import type { AppVariables, CommandEnvelope, Env } from "../types";
import { can } from "../security/permissions";
import { escapeHtml, layout, money, table } from "../views/html";
import { randomToken, sha256 } from "../security/crypto";
import { toCsv, toPdf, toXlsx } from "../reports";

const finance = new Hono<{ Bindings: Env; Variables: AppVariables }>();
type Row = Record<string, unknown>;
type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

async function scopedPayment(c: AppContext, id: number, columns = "*"): Promise<Row | null> {
  const companyId = c.get("user")!.activeCompanyId;
  return c.env.DB.prepare(`SELECT ${columns} FROM payments WHERE id=?${companyId ? " AND company_id=?" : ""}`)
    .bind(id, ...(companyId ? [companyId] : []))
    .first<Row>();
}

function fixedCompanyAllowed(c: AppContext, requested: unknown): boolean {
  const fixed = c.get("user")!.activeCompanyId;
  return !fixed || Number(requested) === fixed;
}

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
    company = user.activeCompanyId,
    selectedCompany = Number(row.company_id ?? company) || 0,
    paymentId = Number(row.id) || 0,
    search = (c.req.query("party_q") ?? "").trim(),
    selectedParty = Number(row[kind === "customer" ? "customer_id" : "supplier_id"]) || 0,
    filter = search ? " AND (code LIKE ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE OR id=?)" : "",
    filterValues = search ? [`${search}%`, `%${search}%`, selectedParty] : [];
  const targetCompany = selectedCompany || company;
  const [parties, targets, companies, allocation] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT id,code,name FROM ${kind === "customer" ? "customers" : "suppliers"} WHERE active=1${filter} ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,code LIMIT 100`,
    ).bind(...filterValues, selectedParty),
    c.env.DB.prepare(
      `SELECT d.id,d.document_number,d.balance_amount_paise,c.code company_code FROM ${kind === "customer" ? "receivables" : "payables"} d JOIN companies c ON c.id=d.company_id WHERE (d.balance_amount_paise>0${paymentId ? " OR EXISTS(SELECT 1 FROM payment_allocations a WHERE a.payment_id=? AND a.target_id=d.id AND a.target_type=?)" : ""})${targetCompany ? " AND d.company_id=?" : ""} ORDER BY d.due_date,d.document_date,d.id LIMIT 100`,
    ).bind(...(paymentId ? [paymentId, kind === "customer" ? "RECEIVABLE" : "PAYABLE"] : []), ...(targetCompany ? [targetCompany] : [])),
    c.env.DB.prepare(`SELECT id,code,name FROM companies WHERE active=1${company ? " AND id=?" : ""} ORDER BY code`).bind(...(company ? [company] : [])),
    paymentId
      ? c.env.DB.prepare("SELECT target_id FROM payment_allocations WHERE payment_id=? ORDER BY id LIMIT 1").bind(paymentId)
      : c.env.DB.prepare("SELECT NULL target_id WHERE 0"),
  ]);
  const options = (rows: Row[], label: (r: Row) => string, selected: unknown) =>
    rows
      .map(
        (r) =>
          `<option value="${r.id}" ${Number(r.id) === Number(selected) ? "selected" : ""}>${escapeHtml(label(r))}</option>`,
      )
      .join("");
  const companyControl = company
    ? `<input type="hidden" name="company_id" value="${company}">`
    : `<label>Company<select name="company_id" required><option value="">Choose company</option>${options((companies?.results ?? []) as Row[], (r) => `${r.code} — ${r.name}`, selectedCompany)}</select></label>`;
  const selectedTarget = (allocation?.results?.[0] as Row | undefined)?.target_id ?? "";
  const selectedMode = String(row.mode ?? "CASH");
  const modes = ["CASH", "BANK", "UPI", "CHEQUE", "RTGS", "NEFT", "OTHER"].map((mode) => `<option value="${mode}" ${mode === selectedMode ? "selected" : ""}>${mode}</option>`).join("");
  return `<form method="get" class="option-search"><label>Find ${kind}<input name="party_q" value="${escapeHtml(search)}" placeholder="Code or name"></label><button>Search</button></form><form method="post"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><input type="hidden" name="idempotency_key" value="${randomToken(16)}">${companyControl}<label>${kind}<select name="party_id" required>${options((parties?.results ?? []) as Row[], (r) => `${r.code} — ${r.name}`, row[kind === "customer" ? "customer_id" : "supplier_id"])}</select></label><label>Preferred document<select name="target_id"><option value="">Allocate oldest first</option>${options((targets?.results ?? []) as Row[], (r) => `${r.company_code} · ${r.document_number} — ₹${money(r.balance_amount_paise)}`, selectedTarget)}</select></label><label>Date<input type="date" name="payment_date" value="${escapeHtml(row.payment_date ?? new Date().toISOString().slice(0, 10))}" required></label><label>Mode<select name="mode">${modes}</select></label><label>Reference<input name="reference_number" value="${escapeHtml(row.reference_number ?? "")}"></label><label>Amount<input name="amount" value="${row.total_amount_paise ? Number(row.total_amount_paise) / 100 : ""}" required></label><label>Remarks<textarea name="remarks">${escapeHtml(row.remarks ?? "")}</textarea></label><button>Save</button></form>`;
}

finance.get("/payments", async (c) => {
  const user = c.get("user")!;
  if (!can(user, "payments")) return c.text("Forbidden", 403);
  const scoped = user.activeCompanyId ? " WHERE p.company_id=?" : "";
  const result = await c.env.DB.prepare(
    `SELECT p.id,p.payment_date,p.payment_type,p.reference_number,p.mode,p.total_amount_paise,p.allocated_amount_paise,p.unallocated_amount_paise,co.code company,COALESCE(c.name,s.name) party FROM payments p JOIN companies co ON co.id=p.company_id LEFT JOIN customers c ON c.id=p.customer_id LEFT JOIN suppliers s ON s.id=p.supplier_id${scoped} ORDER BY p.payment_date DESC,p.id DESC LIMIT 100`,
  )
    .bind(...(user.activeCompanyId ? [user.activeCompanyId] : []))
    .all<Row>();
  const canMaintain = can(user, "payments", "edit") || can(user, "payments", "deactivate");
  const rows = result.results.map((r) => {
    const opening = String(r.payment_type).startsWith("OPENING_ADVANCE");
    const editUrl = opening ? `/transactions/opening/advance/${r.id}/edit` : `/finance/payments/${r.id}/edit`;
    const deleteUrl = opening ? `/transactions/opening/advance/${r.id}/delete` : `/finance/payments/${r.id}/delete`;
    return [
    escapeHtml(r.payment_date),
    escapeHtml(r.company),
    escapeHtml(r.payment_type),
    escapeHtml(r.party),
    escapeHtml(r.mode),
    `₹${money(r.total_amount_paise)}`,
    `₹${money(r.allocated_amount_paise)}`,
    `₹${money(r.unallocated_amount_paise)}`,
    `${canMaintain || opening && can(user, "opening", "create") ? `<a href="${editUrl}">Edit</a> ` : ""}<a href="/finance/payments/${r.id}/print">Print</a> <a href="/finance/payments/${r.id}/export/csv">Export</a>${canMaintain || opening && can(user, "opening", "create") ? ` <form class="inline-form" method="post" action="${deleteUrl}"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><button type="submit">Delete</button></form>` : ""}`,
  ];});
  return c.html(
    layout(
      "Payments",
      `${can(user, "payments", "create") ? `<details><summary>Customer receipt</summary>${await paymentForm(c, "customer")}</details><details><summary>Supplier payment</summary>${await paymentForm(c, "supplier")}</details>` : ""}${table(["Date", "Company", "Type", "Party", "Mode", "Amount", "Allocated", "Advance", "Actions"], rows)}`,
      user,
    ),
  );
});

async function create(c: AppContext, kind: "customer" | "supplier") {
  const body = (await c.req.parseBody()) as Row,
    user = c.get("user")!;
  if (!can(user, "payments", "create")) return c.text("Forbidden", 403);
  const companyId = Number(body.company_id ?? user.activeCompanyId);
  if (!Number.isSafeInteger(companyId) || companyId <= 0) return c.text("Choose an active company", 400);
  if (!fixedCompanyAllowed(c, companyId)) return c.text("Forbidden", 403);
  if (!await c.env.DB.prepare("SELECT id FROM companies WHERE id=? AND active=1").bind(companyId).first()) return c.text("Invalid or inactive company", 400);
  const payload = {
    companyId,
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
  if (!can(c.get("user"), "payments", "edit") && !can(c.get("user"), "payments", "deactivate")) return c.text("Forbidden", 403);
  const row = await scopedPayment(c, Number(c.req.param("id")));
  if (!row) return c.notFound();
  if (String(row.payment_type).startsWith("OPENING_ADVANCE")) return c.redirect(`/transactions/opening/advance/${row.id}/edit`, 303);
  return c.html(
    layout(
      "Edit Payment",
      await paymentForm(c, row.customer_id ? "customer" : "supplier", row),
      c.get("user"),
    ),
  );
});
finance.post("/payments/:id/edit", async (c) => {
  if (!can(c.get("user"), "payments", "edit") && !can(c.get("user"), "payments", "deactivate")) return c.text("Forbidden", 403);
  const body = (await c.req.parseBody()) as Row,
    row = await scopedPayment(c, Number(c.req.param("id")), "payment_type,company_id");
  if (!row) return c.notFound();
  const companyId = Number(body.company_id ?? row.company_id);
  if (companyId !== Number(row.company_id) || !fixedCompanyAllowed(c, companyId)) return c.text("Forbidden", 403);
  const kind = String(row.payment_type).includes("CUSTOMER")
    ? "customer"
    : "supplier";
  const payload = {
    id: Number(c.req.param("id")),
    companyId,
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
  if (!can(c.get("user"), "payments", "deactivate") && !can(c.get("user"), "payments", "edit")) return c.text("Forbidden", 403);
  const row = await scopedPayment(c, Number(c.req.param("id")), "id,company_id");
  if (!row) return c.notFound();
  const result = await send(c, "payment.delete", {
    id: Number(c.req.param("id")),
    companyId: Number(row.company_id),
  });
  return result.ok
    ? c.redirect("/finance/payments", 303)
    : c.json(result.body, result.status as 400);
});
finance.get("/payments/:id/print", async (c) => {
  if (!can(c.get("user"), "payments", "view")) return c.text("Forbidden", 403);
  const r = await scopedPayment(c, Number(c.req.param("id")));
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
  if (!can(c.get("user"), "payments", "view")) return c.text("Forbidden", 403);
  const format = c.req.param("fmt");
  if (!["csv", "xlsx", "pdf"].includes(format)) return c.text("Unsupported format", 400);
  const r = await scopedPayment(c, Number(c.req.param("id")), "id,payment_date,payment_type,reference_number,total_amount_paise,allocated_amount_paise,unallocated_amount_paise");
  if (!r) return c.notFound();
  const rows = [{ Date: r.payment_date, Type: r.payment_type, Reference: r.reference_number ?? "", Total: money(r.total_amount_paise), Allocated: money(r.allocated_amount_paise), Advance: money(r.unallocated_amount_paise) }];
  if (format === "xlsx") return new Response(toXlsx(rows, `Payment ${r.id}`), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename=payment-${r.id}.xlsx` } });
  if (format === "pdf") return new Response(toPdf(`Payment ${r.reference_number ?? r.id}`, rows), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename=payment-${r.id}.pdf` } });
  return new Response(toCsv(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename=payment-${r.id}.csv` } });
});

export default finance;
