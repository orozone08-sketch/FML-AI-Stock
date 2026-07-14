import { Hono } from "hono";
import type { AppVariables, Env, Role } from "../types";
import { createPbkdf2Hash, hmac, sha256, verifyWerkzeugPbkdf2 } from "../security/crypto";
import { createSession, clearSessionHeaders, revokeSession } from "../auth/session";
import { escapeHtml, formField, layout } from "../views/html";
import { nowIso } from "../db/helpers";

const auth = new Hono<{ Bindings: Env; Variables: AppVariables }>();

function setCookies(c: Parameters<typeof clearSessionHeaders>[0] extends never ? never : any, values: string[]): void {
  for (const value of values) c.header("Set-Cookie", value, { append: true });
}

async function companies(db: D1Database): Promise<Array<Record<string, unknown>>> {
  return (await db.prepare("SELECT id,name,code FROM companies WHERE active=1 ORDER BY code LIMIT 20").all<Record<string, unknown>>()).results;
}

function loginPage(rows: Array<Record<string, unknown>>, message = "", selected = ""): string {
  const options = rows.map((row) => `<option value="${row.id}" ${String(row.id) === selected ? "selected" : ""}>${escapeHtml(row.name)}</option>`).join("");
  const body = `<form method="post"><label>Company<select name="company_id" required><option value="">Choose workspace</option>${options}</select></label>${formField("email", "Login ID", "", "email", true)}${formField("password", "Password", "", "password", true)}<label><input type="checkbox" name="remember" value="1"> Remember me</label><button>Login</button></form><p><a href="/register">Register a company user</a> · <a href="/admin/login">Owner/admin login</a></p>`;
  return layout("Login", body, null, { message });
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
    return c.html(loginPage(rows, "Invalid login ID, password, or company workspace.", String(companyId)), 401);
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
  return c.html(layout("Owner / Admin Login", `<form method="post">${formField("email", "Login ID", "", "email", true)}${formField("password", "Password", "", "password", true)}<label><input type="checkbox" name="remember" value="1"> Remember me</label><button>Login</button></form>`, null));
});

auth.post("/admin/login", async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email ?? "").trim().toLowerCase();
  if (await throttled(c.env, c.req.raw, email)) return c.text("Too many attempts", 429);
  const user = await c.env.DB.prepare("SELECT id,password_hash,role,active FROM users WHERE email=? LIMIT 1").bind(email).first<Record<string, unknown>>();
  const valid = Boolean(user?.active) && user?.role === "ADMIN" && await verifyWerkzeugPbkdf2(String(body.password ?? ""), String(user?.password_hash ?? ""));
  await recordAttempt(c.env, c.req.raw, email, valid);
  if (!valid) return c.html(layout("Owner / Admin Login", `<p>Invalid admin login ID or password.</p><p><a href="/admin/login">Try again</a></p>`, null), 401);
  const session = await createSession(c.env.DB, Number(user!.id), c.req.raw, body.remember === "1");
  setCookies(c, session.headers);
  await c.env.DB.prepare("UPDATE users SET last_login_at=?,updated_at=? WHERE id=?").bind(nowIso(), nowIso(), user!.id).run();
  return c.redirect("/dashboard/", 303);
});

auth.get("/register", async (c) => {
  if (c.get("user")) return c.redirect("/dashboard/", 303);
  const options = (await companies(c.env.DB)).map((row) => `<option value="${row.id}">${escapeHtml(row.name)}</option>`).join("");
  return c.html(layout("Register", `<form method="post"><label>Company<select name="company_id" required>${options}</select></label>${formField("name", "Name", "", "text", true)}${formField("email", "Login ID", "", "email", true)}${formField("password", "Password", "", "password", true)}${formField("confirm_password", "Confirm password", "", "password", true)}<button>Register</button></form>`, null));
});

auth.post("/register", async (c) => {
  const body = await c.req.parseBody();
  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const companyId = Number.parseInt(String(body.company_id ?? ""), 10);
  if (!name || !email || password.length < 8 || password !== String(body.confirm_password ?? "") || !Number.isSafeInteger(companyId)) return c.text("Invalid registration", 400);
  const company = await c.env.DB.prepare("SELECT id FROM companies WHERE id=? AND active=1").bind(companyId).first();
  if (!company) return c.text("Invalid company", 400);
  const now = nowIso();
  try {
    const result = await c.env.DB.prepare(`INSERT INTO users(name,email,password_hash,company_id,role,active,force_password_change,created_at,updated_at)
      VALUES(?,?,?,?,?,1,0,?,?)`).bind(name, email, await createPbkdf2Hash(password), companyId, "ADMIN" satisfies Role, now, now).run();
    await c.env.DB.prepare("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,reference,created_at) VALUES(?,'register','User',?,?,?)")
      .bind(result.meta.last_row_id, String(result.meta.last_row_id), email, now).run();
  } catch { return c.text("That login ID is already registered", 409); }
  return c.redirect("/login", 303);
});

auth.post("/logout", async (c) => {
  const user = c.get("user");
  if (user) await revokeSession(c.env.DB, user.sessionId);
  setCookies(c, clearSessionHeaders(c.req.raw));
  return c.redirect("/login", 303);
});

export default auth;
