import { Hono } from "hono";
import type { AppVariables, Env, Role } from "../types";
import { createPbkdf2Hash, hmac, sha256, verifyWerkzeugPbkdf2 } from "../security/crypto";
import { createSession, clearSessionHeaders, revokeSession } from "../auth/session";
import { authLayout, escapeHtml, formField } from "../views/html";
import { nowIso } from "../db/helpers";

const auth = new Hono<{ Bindings: Env; Variables: AppVariables }>();

function setCookies(c: Parameters<typeof clearSessionHeaders>[0] extends never ? never : any, values: string[]): void {
  for (const value of values) c.header("Set-Cookie", value, { append: true });
}

async function companies(db: D1Database): Promise<Array<Record<string, unknown>>> {
  return (await db.prepare("SELECT id,name,code FROM companies WHERE active=1 ORDER BY code LIMIT 20").all<Record<string, unknown>>()).results;
}

function companyLogo(row: Record<string, unknown>): string {
  const text = `${row.code ?? ""} ${row.name ?? ""}`.toLowerCase();
  if (text.includes("aditya")) return "/static/img/aditya-logo.jpg";
  if (text.includes("first")) return "/static/img/firsttech-logo.jpg";
  return "/static/img/fastockflow-logo-cropped.png";
}

function loginPage(rows: Array<Record<string, unknown>>, message = "", selected = "", email = ""): string {
  const company = rows.find((row) => String(row.id) === selected);
  if (!company) {
    const cards = rows.length ? rows.map((row) => `<a class="auth-company-card" href="/login/company/${row.id}"><span class="auth-company-logo"><img src="${companyLogo(row)}" alt="${escapeHtml(row.name)}"></span><span class="auth-company-copy"><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.code)} secure workspace</small></span><span class="auth-company-arrow" aria-hidden="true">→</span></a>`).join("") : `<div class="empty auth-empty">No active companies are available yet.</div>`;
    return authLayout("FAstockFlow Company Access", `<div class="auth-panel-head"><span class="auth-kicker">Company Selection</span><h2>Select your workspace</h2><p>Continue through the secure workspace assigned to your company.</p></div><div class="auth-company-grid">${cards}</div><div class="auth-action-row"><a class="secondary-button center-button" href="/register">Register user</a><a class="secondary-button center-button" href="/admin/login">Owner/admin login</a></div>`, message);
  }
  return authLayout(`${escapeHtml(company.name)} Login`, `<form class="login-card auth-login-card" method="post" action="/login"><input type="hidden" name="company_id" value="${company.id}"><a class="auth-back-link" href="/login">← Back to company selection</a><div class="auth-selected-company"><span class="auth-selected-logo"><img src="${companyLogo(company)}" alt="${escapeHtml(company.name)}"></span><span><span class="auth-kicker">${escapeHtml(company.code)} Workspace</span><strong>${escapeHtml(company.name)}</strong><small>Only ${escapeHtml(company.name)} users can sign in here.</small></span></div><label class="auth-field">Login ID / Username<input name="email" type="text" value="${escapeHtml(email)}" autocomplete="username" required autofocus></label><label class="auth-field">Password<span class="password-wrap"><input id="password" name="password" type="password" autocomplete="current-password" required><button type="button" class="icon-button" data-toggle-password="#password">Show</button></span></label><div class="auth-form-options"><label class="checkbox-line"><input name="remember" type="checkbox" value="1"><span>Remember me</span></label><button class="link-button auth-note-button" type="button" data-auth-note="Please contact the owner/admin to reset this password.">Forgot password?</button></div><button class="primary-button full" type="submit">Sign in securely</button><div class="login-secondary-actions auth-secondary-actions"><a class="secondary-button center-button" href="/register">Register user</a><a class="secondary-button center-button" href="/admin/login">Owner/admin login</a></div></form>`, message);
}

async function recordAttempt(env: Env, request: Request, email: string, succeeded: boolean): Promise<void> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  await env.DB.prepare("INSERT INTO login_attempts(identifier_digest,ip_prefix_digest,succeeded,created_at) VALUES(?,?,?,?)")
    .bind(await hmac(email, env.SESSION_HMAC_KEY), await hmac(ip, env.SESSION_HMAC_KEY), succeeded ? 1 : 0, nowIso()).run();
}

async function throttled(env: Env, request: Request, email: string): Promise<boolean> {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const result = await env.DB.prepare(`SELECT COUNT(*) AS failures FROM login_attempts
    WHERE succeeded=0 AND created_at>=? AND (identifier_digest=? OR ip_prefix_digest=?)`)
    .bind(since, await hmac(email, env.SESSION_HMAC_KEY), await hmac(ip, env.SESSION_HMAC_KEY)).first<{ failures: number }>();
  return Number(result?.failures ?? 0) >= 10;
}

auth.get("/", (c) => c.redirect(c.get("user") ? "/dashboard/" : "/login", 303));

auth.get("/login", async (c) => {
  if (c.get("user")) return c.redirect("/dashboard/", 303);
  c.header("Cache-Control", "no-store");
  return c.html(loginPage(await companies(c.env.DB), "", c.req.query("company_id") ?? ""));
});

auth.get("/login/company/:id", async (c) => {
  if (c.get("user")) return c.redirect("/dashboard/", 303);
  c.header("Cache-Control", "no-store");
  return c.html(loginPage(await companies(c.env.DB), "", c.req.param("id")));
});

auth.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const companyId = Number.parseInt(String(body.company_id ?? ""), 10);
  const rows = await companies(c.env.DB);
  if (await throttled(c.env, c.req.raw, email)) return c.html(loginPage(rows, "Too many failed attempts. Try again later.", String(companyId)), 429);
  const user = await c.env.DB.prepare("SELECT id,name,email,password_hash,company_id,role,active FROM users WHERE email=? LIMIT 1").bind(email).first<Record<string, unknown>>();
  const valid = Boolean(user?.active) && await verifyWerkzeugPbkdf2(password, String(user?.password_hash ?? ""));
  const companyValid = user?.company_id != null && Number(user.company_id) === companyId;
  if (!valid || !companyValid) {
    await recordAttempt(c.env, c.req.raw, email, false);
    return c.html(loginPage(rows, "Invalid login ID, password, or company workspace.", String(companyId), email), 401);
  }
  await recordAttempt(c.env, c.req.raw, email, true);
  const session = await createSession(c.env.DB, Number(user!.id), c.req.raw, body.remember === "1");
  setCookies(c, session.headers);
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET last_login_at=?,updated_at=? WHERE id=?").bind(now, now, user!.id),
    c.env.DB.prepare("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,reference,created_at) VALUES(?,'login','User',?,?,?)").bind(user!.id, String(user!.id), email, now),
  ]);
  const next = c.req.query("next");
  return c.redirect(next?.startsWith("/") && !next.startsWith("//") ? next : "/dashboard/", 303);
});

auth.get("/admin/login", async (c) => {
  if (c.get("user")) return c.redirect("/dashboard/", 303);
  c.header("Cache-Control", "no-store");
  return c.html(authLayout("Owner / Admin Login", `<div class="auth-panel-head"><span class="auth-kicker">Administration</span><h2>Owner / admin login</h2></div><form class="login-card auth-login-card" method="post">${formField("email", "Login ID", "", "email", true)}${formField("password", "Password", "", "password", true)}<label class="checkbox-line"><input type="checkbox" name="remember" value="1"><span>Remember me</span></label><button class="primary-button full">Sign in securely</button><a class="secondary-button center-button" href="/login">Back to company selection</a></form>`));
});

auth.post("/admin/login", async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email ?? "").trim().toLowerCase();
  if (await throttled(c.env, c.req.raw, email)) return c.text("Too many attempts", 429);
  const user = await c.env.DB.prepare("SELECT id,password_hash,role,active FROM users WHERE email=? LIMIT 1").bind(email).first<Record<string, unknown>>();
  const valid = Boolean(user?.active) && user?.role === "ADMIN" && await verifyWerkzeugPbkdf2(String(body.password ?? ""), String(user?.password_hash ?? ""));
  await recordAttempt(c.env, c.req.raw, email, valid);
  if (!valid) return c.html(authLayout("Owner / Admin Login", `<div class="auth-panel-head"><span class="auth-kicker">Administration</span><h2>Access denied</h2><p>Invalid admin login ID or password.</p></div><a class="primary-button center-button" href="/admin/login">Try again</a>`), 401);
  const session = await createSession(c.env.DB, Number(user!.id), c.req.raw, body.remember === "1");
  setCookies(c, session.headers);
  await c.env.DB.prepare("UPDATE users SET last_login_at=?,updated_at=? WHERE id=?").bind(nowIso(), nowIso(), user!.id).run();
  return c.redirect("/dashboard/", 303);
});

auth.get("/register", async (c) => {
  if (c.get("user")) return c.redirect("/dashboard/", 303);
  const options = (await companies(c.env.DB)).map((row) => `<option value="${row.id}">${escapeHtml(row.name)}</option>`).join("");
  return c.html(authLayout("Register", `<div class="auth-panel-head"><span class="auth-kicker">Invited access</span><h2>Register company user</h2></div><form class="login-card auth-login-card" method="post">${formField("invite_key", "Registration invite", "", "password", true)}<label class="form-field">Company<select name="company_id" required>${options}</select></label>${formField("name", "Name", "", "text", true)}${formField("email", "Login ID", "", "email", true)}${formField("password", "Password", "", "password", true)}${formField("confirm_password", "Confirm password", "", "password", true)}<button class="primary-button full">Register securely</button><a class="secondary-button center-button" href="/login">Back to company selection</a></form>`));
});

auth.post("/register", async (c) => {
  const body = await c.req.parseBody();
  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const inviteValid = await hmac(String(body.invite_key ?? ""), c.env.CSRF_HMAC_KEY) === await hmac(c.env.REGISTRATION_INVITE_KEY, c.env.CSRF_HMAC_KEY);
  const companyId = Number.parseInt(String(body.company_id ?? ""), 10);
  if (!inviteValid) return c.text("Invalid registration invite", 403);
  if (!name || !email || password.length < 8 || password !== String(body.confirm_password ?? "") || !Number.isSafeInteger(companyId)) return c.text("Invalid registration", 400);
  const company = await c.env.DB.prepare("SELECT id FROM companies WHERE id=? AND active=1").bind(companyId).first();
  if (!company) return c.text("Invalid company", 400);
  const now = nowIso();
  try {
    const result = await c.env.DB.prepare(`INSERT INTO users(name,email,password_hash,company_id,role,active,force_password_change,created_at,updated_at)
      VALUES(?,?,?,?,?,1,0,?,?)`).bind(name, email, await createPbkdf2Hash(password), companyId, "ADMIN" satisfies Role, now, now).run();
    await c.env.DB.prepare("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,reference,created_at) VALUES(?,'register','User',?,?,?)")
      .bind(result.meta.last_row_id, String(result.meta.last_row_id), email, now).run();
  } catch (error) {
    console.error(JSON.stringify({ event: "registration_failed", requestId: c.get("requestId"), error: error instanceof Error ? error.message : String(error) }));
    return c.text(error instanceof Error && error.message.includes("UNIQUE") ? "That login ID is already registered" : "Registration could not be completed", error instanceof Error && error.message.includes("UNIQUE") ? 409 : 500);
  }
  return c.redirect("/login", 303);
});

auth.post("/logout", async (c) => {
  const user = c.get("user");
  if (user) await revokeSession(c.env.DB, user.sessionId);
  setCookies(c, clearSessionHeaders(c.req.raw));
  return c.redirect("/login", 303);
});

export default auth;
