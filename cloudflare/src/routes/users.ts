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
    ? c.env.DB.prepare("SELECT u.id,u.name,u.email,u.role,u.active,u.last_login_at,c.name company FROM users u LEFT JOIN companies c ON c.id=u.company_id WHERE u.company_id=? ORDER BY u.active DESC,u.name").bind(scoped)
    : c.env.DB.prepare("SELECT u.id,u.name,u.email,u.role,u.active,u.last_login_at,c.name company FROM users u LEFT JOIN companies c ON c.id=u.company_id ORDER BY u.active DESC,u.name");
  const rows = (await query.all<Record<string, unknown>>()).results.map((row) => [
    escapeHtml(row.name), escapeHtml(row.email), escapeHtml(row.company ?? "Owner / all companies"), escapeHtml(row.role),
    `<span class="status ${row.active ? "ok" : "muted"}">${row.active ? "Active" : "Inactive"}</span>`,
    escapeHtml(row.last_login_at ?? ""),
    `<span class="actions">${can(actor, "users", "edit") ? `<a href="/users/${row.id}/edit">Edit</a>` : ""}${row.active && can(actor, "users", "deactivate") ? ` <form method="post" action="/users/${row.id}/deactivate" data-confirm="Deactivate this user?"><input type="hidden" name="csrf_token" value="${escapeHtml(actor.csrfToken)}"><button class="link-button" type="submit">Deactivate</button></form>` : ""}</span>`,
  ]);
  const toolbar = `<div class="toolbar" data-live-search-form><input placeholder="Search users" autocomplete="off" data-live-search data-live-target="#users_table"><button class="secondary-button" type="button" data-live-find>Find</button>${can(actor, "users", "create") ? '<a class="primary-button" href="/users/new">Add user</a>' : ""}</div>`;
  const usersTable = table(["Name", "Login ID", "Company", "Role", "Status", "Last login", "Actions"], rows).replace("<table>", '<table id="users_table">');
  return c.html(layout("Users", `<section class="panel">${toolbar}${usersTable.replace('<section class="panel">', "").replace("</section>", "")}</section>`, actor, { subtitle: "Manage staff logins, roles, status, and password resets." }));
});

async function companyOptions(db: D1Database, selected: unknown, scoped: number | null): Promise<string> {
  const rows = await db.prepare(`SELECT id,name,code FROM companies WHERE active=1${scoped ? " AND id=?" : ""} ORDER BY code`).bind(...(scoped ? [scoped] : [])).all<Record<string, unknown>>();
  return rows.results.map((row) => `<option value="${row.id}" ${Number(row.id) === Number(selected) ? "selected" : ""}>${escapeHtml(row.code)} — ${escapeHtml(row.name)}</option>`).join("");
}

type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

async function userForm(c: AppContext, row: Record<string, unknown> = {}, permissionRecords: Row[] = []): Promise<string> {
  const actor = c.get("user")!;
  const selectedRole = row.role ?? "VIEWER";
  const roles = ROLES.map((role) => `<option ${selectedRole === role ? "selected" : ""}>${role}</option>`).join("");
  const byModule = new Map(permissionRecords.map((permission) => [String(permission.module), permission]));
  const scoped = actorScope(actor);
  const permissionRows = MODULES.map((module) => `<tr><td>${escapeHtml(module)}</td>${ACTIONS.map((action) => {
    const current = byModule.get(module)?.[`can_${action}`];
    return `<td><select name="perm__${module}__${action}"><option value="" ${current == null ? "selected" : ""}>Inherit</option><option value="allow" ${current === 1 || current === true ? "selected" : ""}>Allow</option><option value="deny" ${current === 0 || current === false ? "selected" : ""}>Deny</option></select></td>`;
  }).join("")}</tr>`).join("");
  const companyControl = scoped
    ? `<input type="hidden" name="company_id" value="${scoped}"><input value="Active company" disabled>`
    : `<select name="company_id"><option value="" ${row.company_id ? "" : "selected"}>Owner / all companies</option>${await companyOptions(c.env.DB, row.company_id, null)}</select>`;
  return layout(row.id ? "Edit User" : "Add User", `<section class="panel"><form method="post" class="form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(actor.csrfToken)}">${formField("name", "Name", row.name, "text", true)}${formField("email", "Login ID", row.email, "text", true)}<label>Company${companyControl}</label><label>Role<select name="role">${roles}</select></label>${formField("password", "Temporary/new password", "", "password", !row.id)}<label class="check"><input name="active" type="checkbox" value="1" ${row.active !== 0 ? "checked" : ""}> Active</label><label class="check"><input name="force_password_change" type="checkbox" value="1" ${row.force_password_change ? "checked" : ""}> Require password change</label><details class="full-span permission-box"><summary>Granular permission overrides</summary><p class="muted-copy">Leave blank to inherit the selected role. Use overrides only for exceptions.</p><div class="table-wrap"><table><thead><tr><th>Module</th>${ACTIONS.map((action) => `<th>${action[0]?.toUpperCase()}${action.slice(1)}</th>`).join("")}</tr></thead><tbody>${permissionRows}</tbody></table></div></details><div class="form-actions full-span"><a class="secondary-button" href="/users/">Cancel</a><button class="primary-button" type="submit">Save User</button></div></form></section>`, actor, { subtitle: "Passwords are hashed; deactivation preserves historical attribution." });
}

type Row = Record<string, unknown>;

function permissionStatements(c: AppContext, userId: number, body: Row): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [c.env.DB.prepare("DELETE FROM permission_overrides WHERE user_id=?").bind(userId)];
  for (const module of MODULES) {
    const values = ACTIONS.map((action) => {
      const value = String(body[`perm__${module}__${action}`] ?? "");
      return value === "allow" ? 1 : value === "deny" ? 0 : null;
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
    if (existing.role === "ADMIN" && existing.company_id == null && (role !== "ADMIN" || body.active !== "1" || companyId != null)) {
      const count = await c.env.DB.prepare("SELECT COUNT(*) count FROM users WHERE role='ADMIN' AND active=1 AND id<>? AND company_id IS NULL").bind(id).first<{count:number}>();
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
  if (target.role === "ADMIN" && target.company_id == null) { const count = await c.env.DB.prepare("SELECT COUNT(*) count FROM users WHERE role='ADMIN' AND active=1 AND id<>? AND company_id IS NULL").bind(id).first<{count:number}>(); if (!count?.count) return c.text("The last active administrator cannot be removed",409); }
  const now=nowIso(); await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET active=0,updated_at=?,updated_by_id=? WHERE id=?").bind(now,actor.id,id),
    c.env.DB.prepare("INSERT INTO audit_logs(user_id,company_id,action,entity_type,entity_id,reference,created_at) VALUES(?,?,'deactivate','User',?,?,?)").bind(actor.id,target.company_id ?? null,String(id),"user deactivated",now),
  ]); return c.redirect("/users/",303);
});

export default users;
