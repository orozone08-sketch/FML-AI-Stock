import { Hono, type Context } from "hono";
import type { AppVariables, Env, Role } from "../types";
import { can, MODULES } from "../security/permissions";
import { createPbkdf2Hash } from "../security/crypto";
import { escapeHtml, formField, layout, table } from "../views/html";
import { nowIso } from "../db/helpers";

const users = new Hono<{ Bindings: Env; Variables: AppVariables }>();
const ROLES: Role[] = ["ADMIN", "STOCK", "SALES", "ACCOUNTS", "VIEWER"];

users.get("/", async (c) => {
  const actor = c.get("user")!; if (!can(actor, "users")) return c.text("Forbidden", 403);
  const scoped = actor.companyId ?? actor.activeCompanyId;
  const query = scoped
    ? c.env.DB.prepare("SELECT u.id,u.name,u.email,u.role,u.active,c.code company FROM users u LEFT JOIN companies c ON c.id=u.company_id WHERE u.company_id=? ORDER BY u.active DESC,u.name LIMIT 100").bind(scoped)
    : c.env.DB.prepare("SELECT u.id,u.name,u.email,u.role,u.active,c.code company FROM users u LEFT JOIN companies c ON c.id=u.company_id ORDER BY u.active DESC,u.name LIMIT 100");
  const rows = (await query.all<Record<string, unknown>>()).results.map((row) => [escapeHtml(row.name), escapeHtml(row.email), escapeHtml(row.company ?? "All"), escapeHtml(row.role), row.active ? "Active" : "Inactive", `<a href="/users/${row.id}/edit">Edit</a>`]);
  return c.html(layout("Users", `${can(actor, "users", "create") ? '<p><a class="button" href="/users/new">New user</a></p>' : ""}${table(["Name", "Login ID", "Company", "Role", "Status", "Actions"], rows)}`, actor));
});

async function companyOptions(db: D1Database, selected: unknown): Promise<string> {
  const rows = await db.prepare("SELECT id,name,code FROM companies WHERE active=1 ORDER BY code").all<Record<string, unknown>>();
  return rows.results.map((row) => `<option value="${row.id}" ${Number(row.id) === Number(selected) ? "selected" : ""}>${escapeHtml(row.code)} — ${escapeHtml(row.name)}</option>`).join("");
}

type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

async function userForm(c: AppContext, row: Record<string, unknown> = {}): Promise<string> {
  const actor = c.get("user")!;
  const roles = ROLES.map((role) => `<option ${row.role === role ? "selected" : ""}>${role}</option>`).join("");
  const overrides = MODULES.map((module) => `<fieldset><legend>${escapeHtml(module)}</legend>${["view","create","edit","approve","export","deactivate"].map((action) => `<label><input type="checkbox" name="perm_${module}_${action}" value="1">${action}</label>`).join("")}</fieldset>`).join("");
  return layout(row.id ? "Edit User" : "New User", `<form method="post"><input type="hidden" name="csrf_token" value="${escapeHtml(actor.csrfToken)}">${formField("name", "Name", row.name, "text", true)}${formField("email", "Login ID", row.email, "email", true)}${formField("password", row.id ? "New password (optional)" : "Temporary password", "", "password", !row.id)}<label>Company<select name="company_id"><option value="">All companies</option>${await companyOptions(c.env.DB, row.company_id)}</select></label><label>Role<select name="role">${roles}</select></label><label><input type="checkbox" name="active" value="1" ${row.active !== 0 ? "checked" : ""}> Active</label><label><input type="checkbox" name="force_password_change" value="1" ${row.force_password_change ? "checked" : ""}> Force password change</label><details><summary>Permission overrides</summary>${overrides}</details><button>Save</button></form>`, actor);
}

users.get("/new", async (c) => can(c.get("user"), "users", "create") ? c.html(await userForm(c)) : c.text("Forbidden", 403));
users.get("/:id/edit", async (c) => {
  const actor = c.get("user")!; if (!can(actor, "users", "edit")) return c.text("Forbidden", 403);
  const row = await c.env.DB.prepare("SELECT * FROM users WHERE id=?").bind(Number.parseInt(c.req.param("id"), 10)).first<Record<string, unknown>>();
  if (!row || (actor.companyId && Number(row.company_id) !== actor.companyId)) return c.notFound();
  return c.html(await userForm(c, row));
});

async function save(c: AppContext, id?: number): Promise<Response> {
  const actor = c.get("user")!; const action = id ? "edit" : "create";
  if (!can(actor, "users", action as "create" | "edit")) return c.text("Forbidden", 403);
  const body = await c.req.parseBody(); const name = String(body.name ?? "").trim(); const email = String(body.email ?? "").trim().toLowerCase();
  const role = String(body.role ?? "VIEWER") as Role; const password = String(body.password ?? "");
  if (!name || !email || !ROLES.includes(role) || (!id && password.length < 8)) return c.text("Invalid user", 400);
  const requestedCompany = body.company_id ? Number.parseInt(String(body.company_id), 10) : null;
  const companyId = actor.companyId ?? requestedCompany;
  const now = nowIso();
  if (id) {
    const existing = await c.env.DB.prepare("SELECT role,active,company_id FROM users WHERE id=?").bind(id).first<Record<string, unknown>>(); if (!existing) return c.notFound();
    if (actor.companyId && Number(existing.company_id) !== actor.companyId) return c.text("Forbidden", 403);
    if (existing.role === "ADMIN" && (role !== "ADMIN" || body.active !== "1")) {
      const count = await c.env.DB.prepare("SELECT COUNT(*) count FROM users WHERE role='ADMIN' AND active=1 AND id<>?").bind(id).first<{count:number}>();
      if (Number(count?.count ?? 0) === 0) return c.text("The last active administrator cannot be removed", 409);
    }
    const statements = [c.env.DB.prepare("UPDATE users SET name=?,email=?,company_id=?,role=?,active=?,force_password_change=?,updated_at=?,updated_by_id=? WHERE id=?").bind(name,email,companyId,role,body.active === "1" ? 1 : 0,body.force_password_change === "1" ? 1 : 0,now,actor.id,id)];
    if (password) statements.push(c.env.DB.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(await createPbkdf2Hash(password),id));
    statements.push(c.env.DB.prepare("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,reference,created_at) VALUES(?,'edit','User',?,?,?)").bind(actor.id,String(id),email,now));
    await c.env.DB.batch(statements);
  } else {
    const result = await c.env.DB.prepare("INSERT INTO users(name,email,password_hash,company_id,role,active,force_password_change,created_at,updated_at,created_by_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(name,email,await createPbkdf2Hash(password),companyId,role,body.active === "1" ? 1 : 0,body.force_password_change === "1" ? 1 : 0,now,now,actor.id).run();
    await c.env.DB.prepare("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,reference,created_at) VALUES(?,'create','User',?,?,?)").bind(actor.id,String(result.meta.last_row_id),email,now).run();
  }
  return c.redirect("/users/",303);
}

users.post("/new", (c) => save(c));
users.post("/:id/edit", (c) => save(c, Number.parseInt(c.req.param("id"), 10)));
users.post("/:id/deactivate", async (c) => {
  const actor = c.get("user")!; if (!can(actor,"users","deactivate")) return c.text("Forbidden",403);
  const id = Number.parseInt(c.req.param("id"),10); const target = await c.env.DB.prepare("SELECT role,company_id FROM users WHERE id=?").bind(id).first<Record<string,unknown>>(); if (!target) return c.notFound();
  if (target.role === "ADMIN") { const count = await c.env.DB.prepare("SELECT COUNT(*) count FROM users WHERE role='ADMIN' AND active=1 AND id<>?").bind(id).first<{count:number}>(); if (!count?.count) return c.text("The last active administrator cannot be removed",409); }
  await c.env.DB.prepare("UPDATE users SET active=0,updated_at=?,updated_by_id=? WHERE id=?").bind(nowIso(),actor.id,id).run(); return c.redirect("/users/",303);
});

export default users;
