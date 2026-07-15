import { Hono, type Context } from "hono";
import type { Action, AppVariables, AuthUser, Env, Role } from "../types";
import { can, MODULES } from "../security/permissions";
import { createPbkdf2Hash } from "../security/crypto";
import { escapeHtml, formField, layout, table } from "../views/html";
import { nowIso } from "../db/helpers";

const users = new Hono<{ Bindings: Env; Variables: AppVariables }>();
const ROLES: Role[] = ["ADMIN", "STOCK", "SALES", "ACCOUNTS", "VIEWER"];
const ACTIONS: Action[] = ["view", "create", "edit", "approve", "export", "deactivate"];

// Selecting a workspace filters accounting data, but it must not reduce the
// administration scope of a global administrator. Fixed-company users remain
// confined to their assigned company.
function actorScope(actor: AuthUser): number | null {
  return actor.companyId ?? (actor.role === "ADMIN" ? null : actor.activeCompanyId);
}

users.get("/", async (c) => {
  const actor = c.get("user")!; if (!can(actor, "users")) return c.text("Forbidden", 403);
  const scoped = actorScope(actor);
  const query = scoped
    ? c.env.DB.prepare("SELECT u.id,u.name,u.email,u.role,u.active,c.code company FROM users u LEFT JOIN companies c ON c.id=u.company_id WHERE u.company_id=? ORDER BY u.active DESC,u.name LIMIT 100").bind(scoped)
    : c.env.DB.prepare("SELECT u.id,u.name,u.email,u.role,u.active,c.code company FROM users u LEFT JOIN companies c ON c.id=u.company_id ORDER BY u.active DESC,u.name LIMIT 100");
  const rows = (await query.all<Record<string, unknown>>()).results.map((row) => [escapeHtml(row.name), escapeHtml(row.email), escapeHtml(row.company ?? "All"), escapeHtml(row.role), row.active ? "Active" : "Inactive", `${can(actor, "users", "edit") ? `<a href="/users/${row.id}/edit">Edit</a>` : ""}${row.active && can(actor, "users", "deactivate") && Number(row.id) !== actor.id ? ` <form class="inline-form" method="post" action="/users/${row.id}/deactivate"><input type="hidden" name="csrf_token" value="${escapeHtml(actor.csrfToken)}"><button type="submit">Deactivate</button></form>` : ""}`]);
  return c.html(layout("Users", `${can(actor, "users", "create") ? '<p><a class="button" href="/users/new">New user</a></p>' : ""}${table(["Name", "Login ID", "Company", "Role", "Status", "Actions"], rows)}`, actor));
});

async function companyOptions(db: D1Database, selected: unknown, scoped: number | null): Promise<string> {
  const rows = await db.prepare(`SELECT id,name,code FROM companies WHERE active=1${scoped ? " AND id=?" : ""} ORDER BY code`).bind(...(scoped ? [scoped] : [])).all<Record<string, unknown>>();
  return rows.results.map((row) => `<option value="${row.id}" ${Number(row.id) === Number(selected) ? "selected" : ""}>${escapeHtml(row.code)} — ${escapeHtml(row.name)}</option>`).join("");
}

type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

async function userForm(c: AppContext, row: Record<string, unknown> = {}, permissionRows: Row[] = []): Promise<string> {
  const actor = c.get("user")!;
  const selectedRole = row.role ?? "VIEWER";
  const roles = ROLES.map((role) => `<option ${selectedRole === role ? "selected" : ""}>${role}</option>`).join("");
  const byModule = new Map(permissionRows.map((permission) => [String(permission.module), permission]));
  const overrides = MODULES.map((module) => `<fieldset><legend>${escapeHtml(module)}</legend>${ACTIONS.map((action) => {
    const current = byModule.get(module)?.[`can_${action}`];
    return `<label>${action}<select name="perm_${module}_${action}"><option value="" ${current == null ? "selected" : ""}>Inherit role</option><option value="1" ${current === 1 || current === true ? "selected" : ""}>Allow</option><option value="0" ${current === 0 || current === false ? "selected" : ""}>Deny</option></select></label>`;
  }).join("")}</fieldset>`).join("");
  const scoped = actorScope(actor);
  return layout(row.id ? "Edit User" : "New User", `<form method="post"><input type="hidden" name="csrf_token" value="${escapeHtml(actor.csrfToken)}">${formField("name", "Name", row.name, "text", true)}${formField("email", "Login ID", row.email, "email", true)}${formField("password", row.id ? "New password (optional)" : "Temporary password", "", "password", !row.id)}<label>Company<select name="company_id">${scoped ? "" : '<option value="">All companies</option>'}${await companyOptions(c.env.DB, row.company_id ?? scoped, scoped)}</select></label><label>Role<select name="role">${roles}</select></label><label><input type="checkbox" name="active" value="1" ${row.active !== 0 ? "checked" : ""}> Active</label><label><input type="checkbox" name="force_password_change" value="1" ${row.force_password_change ? "checked" : ""}> Force password change</label><details><summary>Permission overrides</summary><p>Each setting can inherit the selected role, or explicitly allow or deny the action.</p>${overrides}</details><button>Save</button></form>`, actor);
}

type Row = Record<string, unknown>;

function permissionStatements(c: AppContext, userId: number, body: Row): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [c.env.DB.prepare("DELETE FROM permission_overrides WHERE user_id=?").bind(userId)];
  for (const module of MODULES) {
    const values = ACTIONS.map((action) => {
      const value = String(body[`perm_${module}_${action}`] ?? "");
      return value === "1" ? 1 : value === "0" ? 0 : null;
    });
    if (values.some((value) => value != null)) statements.push(c.env.DB.prepare(`INSERT INTO permission_overrides(user_id,module,${ACTIONS.map((action) => `can_${action}`).join(",")}) VALUES(?,?,?,?,?,?,?,?)`).bind(userId, module, ...values));
  }
  return statements;
}

users.get("/new", async (c) => can(c.get("user"), "users", "create") ? c.html(await userForm(c)) : c.text("Forbidden", 403));
users.get("/:id/edit", async (c) => {
  const actor = c.get("user")!; if (!can(actor, "users", "edit")) return c.text("Forbidden", 403);
  const scoped = actorScope(actor); const id = Number.parseInt(c.req.param("id"), 10);
  const row = await c.env.DB.prepare(`SELECT * FROM users WHERE id=?${scoped ? " AND company_id=?" : ""}`).bind(id, ...(scoped ? [scoped] : [])).first<Record<string, unknown>>();
  if (!row) return c.notFound();
  const permissions = await c.env.DB.prepare("SELECT module,can_view,can_create,can_edit,can_approve,can_export,can_deactivate FROM permission_overrides WHERE user_id=? ORDER BY module").bind(id).all<Row>();
  return c.html(await userForm(c, row, permissions.results));
});

async function save(c: AppContext, id?: number): Promise<Response> {
  const actor = c.get("user")!; const action = id ? "edit" : "create";
  if (!can(actor, "users", action as "create" | "edit")) return c.text("Forbidden", 403);
  const body = await c.req.parseBody(); const name = String(body.name ?? "").trim(); const email = String(body.email ?? "").trim().toLowerCase();
  const role = String(body.role ?? "VIEWER") as Role; const password = String(body.password ?? "");
  if (!name || !email || !ROLES.includes(role) || ((!id || password) && password.length < 8)) return c.text("Invalid user", 400);
  const requestedCompany = body.company_id ? Number.parseInt(String(body.company_id), 10) : null;
  const scoped = actorScope(actor); const companyId = scoped ?? requestedCompany;
  if (companyId == null && role !== "ADMIN") return c.text("Only global administrators can be assigned to all companies", 400);
  if (companyId != null && (!Number.isSafeInteger(companyId) || companyId <= 0)) return c.text("Invalid company", 400);
  if (companyId != null) { const company = await c.env.DB.prepare("SELECT id FROM companies WHERE id=? AND active=1").bind(companyId).first(); if (!company) return c.text("Invalid or inactive company", 400); }
  const now = nowIso();
  if (id) {
    const existing = await c.env.DB.prepare(`SELECT role,active,company_id FROM users WHERE id=?${scoped ? " AND company_id=?" : ""}`).bind(id, ...(scoped ? [scoped] : [])).first<Record<string, unknown>>(); if (!existing) return c.notFound();
    if (existing.role === "ADMIN" && (role !== "ADMIN" || body.active !== "1" || Number(existing.company_id) !== Number(companyId))) {
      const count = await c.env.DB.prepare("SELECT COUNT(*) count FROM users WHERE role='ADMIN' AND active=1 AND id<>? AND company_id IS ?").bind(id, existing.company_id ?? null).first<{count:number}>();
      if (Number(count?.count ?? 0) === 0) return c.text("The last active administrator cannot be removed", 409);
    }
    const statements = [c.env.DB.prepare("UPDATE users SET name=?,email=?,company_id=?,role=?,active=?,force_password_change=?,updated_at=?,updated_by_id=? WHERE id=?").bind(name,email,companyId,role,body.active === "1" ? 1 : 0,body.force_password_change === "1" ? 1 : 0,now,actor.id,id)];
    if (password) statements.push(c.env.DB.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(await createPbkdf2Hash(password),id));
    statements.push(...permissionStatements(c, id, body));
    statements.push(c.env.DB.prepare("INSERT INTO audit_logs(user_id,company_id,action,entity_type,entity_id,reference,created_at) VALUES(?,?,'edit','User',?,?,?)").bind(actor.id,companyId,String(id),email,now));
    await c.env.DB.batch(statements);
  } else {
    const result = await c.env.DB.prepare("INSERT INTO users(name,email,password_hash,company_id,role,active,force_password_change,created_at,updated_at,created_by_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(name,email,await createPbkdf2Hash(password),companyId,role,body.active === "1" ? 1 : 0,body.force_password_change === "1" ? 1 : 0,now,now,actor.id).run();
    const newId = Number(result.meta.last_row_id);
    await c.env.DB.batch([...permissionStatements(c, newId, body), c.env.DB.prepare("INSERT INTO audit_logs(user_id,company_id,action,entity_type,entity_id,reference,created_at) VALUES(?,?,'create','User',?,?,?)").bind(actor.id,companyId,String(newId),email,now)]);
  }
  return c.redirect("/users/",303);
}

users.post("/new", (c) => save(c));
users.post("/:id/edit", (c) => save(c, Number.parseInt(c.req.param("id"), 10)));
users.post("/:id/deactivate", async (c) => {
  const actor = c.get("user")!; if (!can(actor,"users","deactivate")) return c.text("Forbidden",403);
  const scoped = actorScope(actor); const id = Number.parseInt(c.req.param("id"),10); const target = await c.env.DB.prepare(`SELECT role,company_id FROM users WHERE id=?${scoped ? " AND company_id=?" : ""}`).bind(id,...(scoped ? [scoped] : [])).first<Record<string,unknown>>(); if (!target) return c.notFound();
  if (id === actor.id) return c.text("You cannot deactivate your own account",409);
  if (target.role === "ADMIN") { const count = await c.env.DB.prepare("SELECT COUNT(*) count FROM users WHERE role='ADMIN' AND active=1 AND id<>? AND company_id IS ?").bind(id,target.company_id ?? null).first<{count:number}>(); if (!count?.count) return c.text("The last active administrator cannot be removed",409); }
  const now=nowIso(); await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET active=0,updated_at=?,updated_by_id=? WHERE id=?").bind(now,actor.id,id),
    c.env.DB.prepare("INSERT INTO audit_logs(user_id,company_id,action,entity_type,entity_id,reference,created_at) VALUES(?,?,'deactivate','User',?,?,?)").bind(actor.id,target.company_id ?? null,String(id),"user deactivated",now),
  ]); return c.redirect("/users/",303);
});

export default users;
