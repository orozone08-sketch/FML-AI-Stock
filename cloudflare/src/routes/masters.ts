import { Hono } from "hono";
import type { Action, AppVariables, Env } from "../types";
import { can } from "../security/permissions";
import { escapeHtml, formField, layout, table } from "../views/html";
import { nowIso } from "../db/helpers";

interface MasterConfig { table: string; module: string; title: string; columns: string[]; form: string[]; companyScoped?: boolean }
const configs: Record<string, MasterConfig> = {
  items: { table: "items", module: "items", title: "Items", columns: ["code", "name", "unit", "hsn", "active"], form: ["code", "name", "unit", "hsn", "notes"] },
  customers: { table: "customers", module: "customers", title: "Customers", columns: ["code", "name", "contact_person", "mobile", "city", "active"], form: ["code", "name", "contact_person", "customer_type", "gst_number", "mobile", "whatsapp", "email", "address", "city", "state", "default_credit_days", "notes"] },
  suppliers: { table: "suppliers", module: "suppliers", title: "Suppliers", columns: ["code", "name", "mobile", "email", "active"], form: ["code", "name", "gst_number", "mobile", "email", "address", "default_credit_days"] },
  companies: { table: "companies", module: "companies", title: "Companies", columns: ["code", "name", "gst_number", "active"], form: ["code", "name", "gst_number"] },
  "stock-books": { table: "stock_books", module: "stock_books", title: "Stock Books", columns: ["code", "name", "company_id", "book_type", "active"], form: ["company_id", "code", "name", "book_type"], companyScoped: true },
};

const masters = new Hono<{ Bindings: Env; Variables: AppVariables }>();

function config(kind: string): MasterConfig | null { return configs[kind] ?? null; }
function authorized(c: any, item: MasterConfig, action: Action): boolean { return can(c.get("user"), item.module, action); }
function normalize(value: unknown): string | number | null { const text = String(value ?? "").trim(); return text === "" ? null : text; }

masters.get("/", (c) => c.redirect("/masters/items", 303));

masters.get("/:kind", async (c) => {
  const item = config(c.req.param("kind"));
  if (!item) return c.notFound();
  if (!authorized(c, item, "view")) return c.text("Forbidden", 403);
  const user = c.get("user")!;
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const active = c.req.query("active") ?? "active";
  const where: string[] = []; const values: unknown[] = [];
  if (active === "active") where.push("active=1"); else if (active === "inactive") where.push("active=0");
  if (q) { where.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)"); values.push(`${q}%`, `${q}%`); }
  if (item.companyScoped && user.activeCompanyId) { where.push("company_id=?"); values.push(user.activeCompanyId); }
  const sql = `SELECT id,${item.columns.join(",")} FROM ${item.table}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY code,id LIMIT 101`;
  const rows = (await c.env.DB.prepare(sql).bind(...values).all<Record<string, unknown>>()).results;
  const rendered = rows.slice(0, 100).map((row) => item.columns.map((column) => escapeHtml(row[column])).concat(`<a href="/masters/${c.req.param("kind")}/${row.id}/edit">Edit</a>`));
  const controls = `<form method="get"><input name="q" value="${escapeHtml(q)}" placeholder="Search code or name"><select name="active"><option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option></select><button>Find</button></form>${authorized(c, item, "create") ? `<p><a class="button" href="/masters/${c.req.param("kind")}/new">New ${escapeHtml(item.title.replace(/s$/, ""))}</a></p>` : ""}`;
  return c.html(layout(item.title, controls + table([...item.columns, "Actions"], rendered), user));
});

masters.get("/:kind/new", async (c) => {
  const item = config(c.req.param("kind")); if (!item) return c.notFound(); if (!authorized(c, item, "create")) return c.text("Forbidden", 403);
  const user = c.get("user")!;
  return c.html(layout(`New ${item.title.replace(/s$/, "")}`, `<form method="post"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}">${item.form.map((field) => formField(field, field.replaceAll("_", " "), "", field === "email" ? "email" : "text", ["code", "name"].includes(field))).join("")}<label><input type="checkbox" name="active" value="1" checked> Active</label><button>Save</button></form>`, user));
});

masters.post("/:kind/new", async (c) => {
  const item = config(c.req.param("kind")); if (!item) return c.notFound(); if (!authorized(c, item, "create")) return c.text("Forbidden", 403);
  const body = await c.req.parseBody(); const user = c.get("user")!; const now = nowIso();
  const columns = [...item.form, "active", "created_at", "updated_at", "created_by_id"];
  const values = item.form.map((field) => normalize(body[field]));
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO ${item.table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).bind(...values, body.active === "1" ? 1 : 0, now, now, user.id),
      c.env.DB.prepare("INSERT INTO audit_logs(user_id,action,entity_type,reference,created_at) VALUES(?,'create',?,?,?)").bind(user.id, item.title, String(body.code ?? ""), now),
    ]);
  } catch (error) { return c.html(layout(`New ${item.title}`, `<p>Could not save: ${escapeHtml(error instanceof Error ? error.message : error)}</p>`, user), 409); }
  return c.redirect(`/masters/${c.req.param("kind")}`, 303);
});

masters.get("/:kind/:id/edit", async (c) => {
  const item = config(c.req.param("kind")); if (!item) return c.notFound(); if (!authorized(c, item, "edit")) return c.text("Forbidden", 403);
  const id = Number.parseInt(c.req.param("id"), 10); const row = await c.env.DB.prepare(`SELECT * FROM ${item.table} WHERE id=?`).bind(id).first<Record<string, unknown>>(); if (!row) return c.notFound();
  const user = c.get("user")!;
  return c.html(layout(`Edit ${item.title.replace(/s$/, "")}`, `<form method="post"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}">${item.form.map((field) => formField(field, field.replaceAll("_", " "), row[field] ?? "", field === "email" ? "email" : "text", ["code", "name"].includes(field))).join("")}<label><input type="checkbox" name="active" value="1" ${row.active ? "checked" : ""}> Active</label><button>Save</button></form>`, user));
});

masters.post("/:kind/:id/edit", async (c) => {
  const item = config(c.req.param("kind")); if (!item) return c.notFound(); if (!authorized(c, item, "edit")) return c.text("Forbidden", 403);
  const id = Number.parseInt(c.req.param("id"), 10); const body = await c.req.parseBody(); const user = c.get("user")!; const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE ${item.table} SET ${item.form.map((field) => `${field}=?`).join(",")},active=?,updated_at=?,updated_by_id=? WHERE id=?`).bind(...item.form.map((field) => normalize(body[field])), body.active === "1" ? 1 : 0, now, user.id, id),
    c.env.DB.prepare("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,created_at) VALUES(?,'edit',?,?,?)").bind(user.id, item.title, String(id), now),
  ]);
  return c.redirect(`/masters/${c.req.param("kind")}`, 303);
});

masters.post("/:kind/:id/deactivate", async (c) => {
  const item = config(c.req.param("kind")); if (!item) return c.notFound(); if (!authorized(c, item, "deactivate")) return c.text("Forbidden", 403);
  await c.env.DB.prepare(`UPDATE ${item.table} SET active=0,updated_at=?,updated_by_id=? WHERE id=?`).bind(nowIso(), c.get("user")!.id, Number.parseInt(c.req.param("id"), 10)).run();
  return c.redirect(`/masters/${c.req.param("kind")}`, 303);
});

export default masters;
