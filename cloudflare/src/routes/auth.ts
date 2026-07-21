import { Hono } from "hono";
import type { AppVariables, Env, Role } from "../types";
import {
  createPbkdf2Hash,
  hmac,
  randomToken,
  sha256,
  verifyWerkzeugPbkdf2,
} from "../security/crypto";
import {
  createSession,
  clearSessionHeaders,
  verifyCsrf,
} from "../auth/session";
import { authLayout, escapeHtml, formField } from "../views/html";
import { cachedReferenceRows } from "../cache/reference";
import { nowIso } from "../db/helpers";
import { assetPaths } from "../generated/assets";

const auth = new Hono<{ Bindings: Env; Variables: AppVariables }>();
const PUBLIC_CSRF_COOKIE = "fastock_public_csrf";

function requestCookie(request: Request, name: string): string | null {
  for (const entry of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, value] = entry.trim().split("=", 2);
    if (key === name && value) return decodeURIComponent(value);
  }
  return null;
}

async function validPublicCsrf(
  value: string | null,
  secret: string,
): Promise<boolean> {
  if (!value) return false;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return false;
  const token = value.slice(0, separator),
    signature = value.slice(separator + 1);
  return token.length >= 32 && signature === (await hmac(token, secret));
}

async function publicCsrf(c: any): Promise<string> {
  const existing = requestCookie(c.req.raw, PUBLIC_CSRF_COOKIE);
  if (await validPublicCsrf(existing, c.env.CSRF_HMAC_KEY)) return existing!;
  const token = randomToken(),
    value = `${token}.${await hmac(token, c.env.CSRF_HMAC_KEY)}`;
  const secure = new URL(c.req.url).protocol === "https:" ? "; Secure" : "";
  c.header(
    "Set-Cookie",
    `${PUBLIC_CSRF_COOKIE}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; HttpOnly${secure}`,
    { append: true },
  );
  return value;
}

async function verifyPublicCsrf(c: any, supplied: unknown): Promise<boolean> {
  const cookie = requestCookie(c.req.raw, PUBLIC_CSRF_COOKIE);
  return (
    typeof supplied === "string" &&
    supplied === cookie &&
    (await validPublicCsrf(cookie, c.env.CSRF_HMAC_KEY))
  );
}

function withPublicCsrf(html: string, csrf: string): string {
  return html.replace(
    /<form([^>]*)>/,
    `<form$1><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">`,
  );
}

function standaloneAuthPage(title: string, card: string, message = "", category = "info"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="login-message" content="${escapeHtml(message)}"><meta name="login-message-category" content="${escapeHtml(category)}"><title>${escapeHtml(title)}</title><script>(()=>{const theme=localStorage.getItem("fastockflow-theme");if(theme==="dark")document.documentElement.dataset.theme="dark";})();</script><link rel="icon" href="${assetPaths.icon}"><link rel="stylesheet" href="${assetPaths.css}"></head><body class="auth-body"><main class="login-page auth-page">${card}</main><script src="${assetPaths.js}"></script></body></html>`;
}

function adminLoginCard(message = "", category = "info"): string {
  return `<form class="login-card auth-login-card" method="post"><div class="flash login-message ${escapeHtml(category)}" data-login-message ${message ? "" : "hidden"}>${escapeHtml(message)}</div><div class="login-brand"><span class="brand-mark large logo-mark"><img src="${assetPaths.icon}" alt="FAstockFlow"></span><div><h1>Owner Login</h1><p>Combined FirstTech and Aditya dashboard.</p></div></div><label>Admin login ID<input name="email" type="text" autocomplete="username" required autofocus></label><label>Password<span class="password-wrap"><input id="admin_password" name="password" type="password" autocomplete="current-password" required><button type="button" class="icon-button" data-toggle-password="#admin_password">Show</button></span></label><div class="auth-form-options"><label class="checkbox-line"><input name="remember" type="checkbox" value="1"><span>Remember me</span></label><button class="link-button auth-note-button" type="button" data-auth-note="Please contact the system owner to reset admin access.">Forgot password?</button></div><button class="primary-button full" type="submit">Login</button><a class="secondary-button full center-button" href="/login">Company login</a></form>`;
}

function setCookies(
  c: Parameters<typeof clearSessionHeaders>[0] extends never ? never : any,
  values: string[],
): void {
  for (const value of values) c.header("Set-Cookie", value, { append: true });
}

async function companies(
  env: Env,
): Promise<Array<Record<string, unknown>>> {
  return cachedReferenceRows(env, "companies", "all", async () => (
    await env.DB
      .prepare(
        "SELECT id,name,code FROM companies WHERE active=1 ORDER BY code",
      )
      .all<Record<string, unknown>>()
  ).results);
}

function companyLogo(row: Record<string, unknown>): string {
  const text = `${row.code ?? ""} ${row.name ?? ""}`.toLowerCase();
  if (text.includes("aditya")) return assetPaths.adityaLogo;
  if (text.includes("first")) return assetPaths.firsttechLogo;
  return assetPaths.logo;
}

function safeNext(value: string | undefined): string | null {
  return value?.startsWith("/") && !value.startsWith("//") ? value : null;
}

function loginPage(
  rows: Array<Record<string, unknown>>,
  message = "",
  selected = "",
  email = "",
  next = "",
): string {
  const nextQuery = safeNext(next)
    ? `?next=${encodeURIComponent(next)}`
    : "";
  const company = rows.find((row) => String(row.id) === selected);
  if (!company) {
    const cards = rows.length
      ? rows
          .map(
            (row) =>
              `<a class="auth-company-card" href="/login/company/${row.id}${nextQuery}"><span class="auth-company-logo"><img src="${companyLogo(row)}" alt="${escapeHtml(row.name)}"></span><span class="auth-company-copy"><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.code)} secure workspace</small></span><span class="auth-company-arrow" aria-hidden="true">→</span></a>`,
          )
          .join("")
      : `<div class="empty auth-empty">No active companies are available yet.</div>`;
    return authLayout(
      "FAstockFlow Company Access",
      `<div class="auth-panel-head"><span class="auth-kicker">Company Selection</span><h2>Select your workspace</h2><p>Continue through the secure workspace assigned to your company.</p></div><div class="auth-company-grid">${cards}</div><div class="auth-action-row"><a class="secondary-button center-button" href="/register">Register user</a><a class="secondary-button center-button" href="/admin/login${nextQuery}">Owner/admin login</a></div>`,
      message,
    );
  }
  return authLayout(
    `${escapeHtml(company.name)} Login`,
    `<form class="login-card auth-login-card" method="post" action="/login${nextQuery}"><input type="hidden" name="company_id" value="${company.id}"><a class="auth-back-link" href="/login${nextQuery}">← Back to company selection</a><div class="auth-selected-company"><span class="auth-selected-logo"><img src="${companyLogo(company)}" alt="${escapeHtml(company.name)}"></span><span><span class="auth-kicker">${escapeHtml(company.code)} Workspace</span><strong>${escapeHtml(company.name)}</strong><small>Only ${escapeHtml(company.name)} users can sign in here.</small></span></div><label class="auth-field">Login ID / Username<input name="email" type="text" value="${escapeHtml(email)}" autocomplete="username" required autofocus></label><label class="auth-field">Password<span class="password-wrap"><input id="password" name="password" type="password" autocomplete="current-password" required><button type="button" class="icon-button" data-toggle-password="#password">Show</button></span></label><div class="auth-form-options"><label class="checkbox-line"><input name="remember" type="checkbox" value="1"><span>Remember me</span></label><button class="link-button auth-note-button" type="button" data-auth-note="Please contact the owner/admin to reset this password.">Forgot password?</button></div><button class="primary-button full" type="submit">Sign in securely</button><div class="login-secondary-actions auth-secondary-actions"><a class="secondary-button center-button" href="/register">Register user</a><a class="secondary-button center-button" href="/admin/login${nextQuery}">Owner/admin login</a></div></form>`,
    message,
  );
}

async function recordAttempt(
  env: Env,
  request: Request,
  email: string,
  succeeded: boolean,
): Promise<void> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  await env.DB.prepare(
    "INSERT INTO login_attempts(identifier_digest,ip_prefix_digest,succeeded,created_at) VALUES(?,?,?,?)",
  )
    .bind(
      await hmac(email, env.SESSION_HMAC_KEY),
      await hmac(ip, env.SESSION_HMAC_KEY),
      succeeded ? 1 : 0,
      nowIso(),
    )
    .run();
}

async function throttled(
  env: Env,
  request: Request,
  email: string,
): Promise<boolean> {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const result = await env.DB.prepare(
    `SELECT COUNT(*) AS failures FROM login_attempts
    WHERE succeeded=0 AND created_at>=? AND (identifier_digest=? OR ip_prefix_digest=?)`,
  )
    .bind(
      since,
      await hmac(email, env.SESSION_HMAC_KEY),
      await hmac(ip, env.SESSION_HMAC_KEY),
    )
    .first<{ failures: number }>();
  return Number(result?.failures ?? 0) >= 10;
}

auth.get("/", (c) =>
  c.redirect(
    c.get("user")?.forcePasswordChange
      ? "/change-password"
      : c.get("user")
        ? "/dashboard/"
        : "/login",
    303,
  ),
);

auth.get("/login", async (c) => {
  if (c.get("user"))
    return c.redirect(
      c.get("user")!.forcePasswordChange
        ? "/change-password"
        : safeNext(c.req.query("next")) ?? "/dashboard/",
      303,
    );
  c.header("Cache-Control", "no-store");
  const csrf = await publicCsrf(c);
  return c.html(
    withPublicCsrf(
      loginPage(await companies(c.env), "", c.req.query("company_id") ?? "", "", c.req.query("next") ?? ""),
      csrf,
    ),
  );
});

auth.get("/login/company/:id", async (c) => {
  if (c.get("user"))
    return c.redirect(
      c.get("user")!.forcePasswordChange
        ? "/change-password"
        : safeNext(c.req.query("next")) ?? "/dashboard/",
      303,
    );
  c.header("Cache-Control", "no-store");
  const csrf = await publicCsrf(c);
  return c.html(
    withPublicCsrf(
      loginPage(await companies(c.env), "", c.req.param("id"), "", c.req.query("next") ?? ""),
      csrf,
    ),
  );
});

async function handleCompanyLogin(c: any, forcedCompanyId?: number) {
  const body = await c.req.parseBody();
  if (!(await verifyPublicCsrf(c, body.csrf_token)))
    return c.text("Invalid CSRF token", 403);
  const email = String(body.email ?? "")
    .trim()
    .toLowerCase();
  const password = String(body.password ?? "");
  const companyId =
    forcedCompanyId ?? Number.parseInt(String(body.company_id ?? ""), 10);
  const rows = await companies(c.env);
  if (await throttled(c.env, c.req.raw, email))
    return c.html(
      withPublicCsrf(
        loginPage(
          rows,
          "Too many failed attempts. Try again later.",
          String(companyId),
          "",
          c.req.query("next") ?? "",
        ),
        String(body.csrf_token),
      ),
      429,
    );
  const user = (await c.env.DB.prepare(
    "SELECT id,name,email,password_hash,company_id,role,active,force_password_change FROM users WHERE email=? LIMIT 1",
  )
    .bind(email)
    .first()) as Record<string, unknown> | null;
  const valid =
    Boolean(user?.active) &&
    (await verifyWerkzeugPbkdf2(password, String(user?.password_hash ?? "")));
  const companyValid =
    user?.company_id != null &&
    Number(user.company_id) === companyId &&
    rows.some((company) => Number(company.id) === companyId);
  if (!valid || !companyValid) {
    await recordAttempt(c.env, c.req.raw, email, false);
    return c.html(
      withPublicCsrf(
        loginPage(
          rows,
          "Invalid login ID, password, or company workspace.",
          String(companyId),
          email,
          c.req.query("next") ?? "",
        ),
        String(body.csrf_token),
      ),
      401,
    );
  }
  await recordAttempt(c.env, c.req.raw, email, true);
  const session = await createSession(
    c.env.DB,
    Number(user!.id),
    c.req.raw,
    body.remember === "1",
  );
  setCookies(c, session.headers);
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET last_login_at=?,updated_at=? WHERE id=?",
    ).bind(now, now, user!.id),
    c.env.DB.prepare(
      "INSERT INTO audit_logs(user_id,company_id,action,entity_type,entity_id,reference,created_at) VALUES(?,?,'login','User',?,?,?)",
    ).bind(user!.id, Number(user!.company_id), String(user!.id), email, now),
  ]);
  const next = c.req.query("next");
  if (user!.force_password_change) return c.redirect("/change-password", 303);
  return c.redirect(
    next?.startsWith("/") && !next.startsWith("//") ? next : "/dashboard/",
    303,
  );
}

auth.post("/login", (c) => handleCompanyLogin(c));
auth.post("/login/company/:id", (c) => {
  const companyId = Number.parseInt(c.req.param("id"), 10);
  return Number.isSafeInteger(companyId) && companyId > 0
    ? handleCompanyLogin(c, companyId)
    : c.text("Invalid company", 400);
});

auth.get("/admin/login", async (c) => {
  if (c.get("user"))
    return c.redirect(
      c.get("user")!.forcePasswordChange
        ? "/change-password"
        : safeNext(c.req.query("next")) ?? "/dashboard/",
      303,
    );
  c.header("Cache-Control", "no-store");
  const csrf = await publicCsrf(c);
  return c.html(
    withPublicCsrf(
      standaloneAuthPage("Owner Login", adminLoginCard()),
      csrf,
    ),
  );
});

auth.post("/admin/login", async (c) => {
  const body = await c.req.parseBody();
  if (!(await verifyPublicCsrf(c, body.csrf_token)))
    return c.text("Invalid CSRF token", 403);
  const email = String(body.email ?? "")
    .trim()
    .toLowerCase();
  if (await throttled(c.env, c.req.raw, email))
    return c.text("Too many attempts", 429);
  const user = await c.env.DB.prepare(
    "SELECT u.id,u.password_hash,u.role,u.active,u.company_id,u.force_password_change FROM users u LEFT JOIN companies co ON co.id=u.company_id WHERE u.email=? AND (u.company_id IS NULL OR co.active=1) LIMIT 1",
  )
    .bind(email)
    .first<Record<string, unknown>>();
  const valid =
    Boolean(user?.active) &&
    user?.role === "ADMIN" &&
    (await verifyWerkzeugPbkdf2(
      String(body.password ?? ""),
      String(user?.password_hash ?? ""),
    ));
  await recordAttempt(c.env, c.req.raw, email, valid);
  if (!valid)
    return c.html(
      standaloneAuthPage("Owner Login", adminLoginCard("Invalid admin login ID or password.", "danger"), "Invalid admin login ID or password.", "danger"),
      401,
    );
  const session = await createSession(
    c.env.DB,
    Number(user!.id),
    c.req.raw,
    body.remember === "1",
  );
  setCookies(c, session.headers);
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET last_login_at=?,updated_at=? WHERE id=?",
    ).bind(now, now, user!.id),
    c.env.DB.prepare(
      "INSERT INTO audit_logs(user_id,company_id,action,entity_type,entity_id,reference,created_at) VALUES(?,?,'login','User',?,?,?)",
    ).bind(user!.id, user!.company_id ?? null, String(user!.id), email, now),
  ]);
  return c.redirect(
    user!.force_password_change
      ? "/change-password"
      : safeNext(c.req.query("next")) ?? "/dashboard/",
    303,
  );
});

auth.get("/change-password", (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=%2Fchange-password", 303);
  return c.html(
    authLayout(
      "Change password",
      `<div class="auth-panel-head"><span class="auth-kicker">Security update</span><h2>Choose a new password</h2><p>${user.forcePasswordChange ? "Your administrator requires a password change before you continue." : "Update your account password."}</p></div><form class="login-card auth-login-card" method="post"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}">${formField("password", "New password", "", "password", true)}${formField("confirm_password", "Confirm new password", "", "password", true)}<button class="primary-button full">Save password</button></form>`,
    ),
  );
});

auth.post("/change-password", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=%2Fchange-password", 303);
  if (!(await verifyCsrf(c))) return c.text("Invalid CSRF token", 403);
  const body = await c.req.parseBody();
  const password = String(body.password ?? "");
  if (password.length < 8 || password !== String(body.confirm_password ?? ""))
    return c.text(
      "Password must be at least 8 characters and both entries must match",
      400,
    );
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET password_hash=?,force_password_change=0,updated_at=?,updated_by_id=? WHERE id=?",
    ).bind(await createPbkdf2Hash(password), now, user.id, user.id),
    c.env.DB.prepare(
      "UPDATE sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL",
    ).bind(now, user.id, user.sessionId),
    c.env.DB.prepare(
      "INSERT INTO audit_logs(user_id,company_id,action,entity_type,entity_id,reference,created_at) VALUES(?,?,'change_password','User',?,'self-service',?)",
    ).bind(
      user.id,
      user.companyId ?? user.activeCompanyId,
      String(user.id),
      now,
    ),
  ]);
  return c.redirect("/dashboard/", 303);
});

auth.get("/register", async (c) => {
  if (c.get("user"))
    return c.redirect(
      c.get("user")!.forcePasswordChange ? "/change-password" : "/dashboard/",
      303,
    );
  const registrationCompanies = await companies(c.env);
  const options = registrationCompanies.map((row, index) => {
    const code = String(row.code ?? "").toUpperCase();
    const logo = code === "AI" ? assetPaths.adityaLogo : code === "FML" ? assetPaths.firsttechLogo : assetPaths.icon;
    return `<label class="login-company-option"><input name="company_id" type="radio" value="${row.id}" required ${index === 0 ? "checked autofocus" : ""}><img src="${logo}" alt="${escapeHtml(row.name)}"><span>${escapeHtml(row.name)}</span><small>${escapeHtml(row.code)} company workspace</small></label>`;
  }).join("");
  const csrf = await publicCsrf(c);
  return c.html(
    withPublicCsrf(
      standaloneAuthPage("Register User", `<form class="login-card login-card-wide auth-register-card" method="post"><div class="flash login-message" data-login-message hidden></div><div class="login-brand"><span class="brand-mark large logo-mark"><img src="${assetPaths.icon}" alt="FAstockFlow"></span><div><h1>Register User</h1><p>Create a company-specific login for stock and account entries.</p></div></div><div class="login-company-options" role="radiogroup" aria-label="Company">${options}</div><div class="login-field-grid"><label>Name<input name="name" type="text" value="" autocomplete="name" required></label><label>Login ID<input name="email" type="text" value="" autocomplete="username" required></label><label>Password<span class="password-wrap"><input id="register_password" name="password" type="password" autocomplete="new-password" required><button type="button" class="icon-button" data-toggle-password="#register_password">Show</button></span></label><label>Confirm password<span class="password-wrap"><input id="register_confirm_password" name="confirm_password" type="password" autocomplete="new-password" required><button type="button" class="icon-button" data-toggle-password="#register_confirm_password">Show</button></span></label></div><button class="primary-button full" type="submit">Create Login</button><a class="secondary-button full center-button" href="/login">Back to company login</a></form>`),
      csrf,
    ),
  );
});

auth.post("/register", async (c) => {
  const body = await c.req.parseBody();
  if (!(await verifyPublicCsrf(c, body.csrf_token)))
    return c.text("Invalid CSRF token", 403);
  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "")
    .trim()
    .toLowerCase();
  const password = String(body.password ?? "");
  const companyId = Number.parseInt(String(body.company_id ?? ""), 10);
  if (
    !name ||
    !email ||
    password.length < 8 ||
    password !== String(body.confirm_password ?? "") ||
    !Number.isSafeInteger(companyId)
  )
    return c.text("Invalid registration", 400);
  const company = await c.env.DB.prepare(
    "SELECT id FROM companies WHERE id=? AND active=1",
  )
    .bind(companyId)
    .first();
  if (!company) return c.text("Invalid company", 400);
  const now = nowIso();
  try {
    const result = await c.env.DB.prepare(
      `INSERT INTO users(name,email,password_hash,company_id,role,active,force_password_change,created_at,updated_at)
      VALUES(?,?,?,?,?,1,0,?,?)`,
    )
      .bind(
        name,
        email,
        await createPbkdf2Hash(password),
        companyId,
        "ADMIN" satisfies Role,
        now,
        now,
      )
      .run();
    await c.env.DB.prepare(
      "INSERT INTO audit_logs(user_id,company_id,action,entity_type,entity_id,reference,created_at) VALUES(?,?,'register','User',?,?,?)",
    )
      .bind(
        result.meta.last_row_id,
        companyId,
        String(result.meta.last_row_id),
        email,
        now,
      )
      .run();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "registration_failed",
        requestId: c.get("requestId"),
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return c.text(
      error instanceof Error && error.message.includes("UNIQUE")
        ? "That login ID is already registered"
        : "Registration could not be completed",
      error instanceof Error && error.message.includes("UNIQUE") ? 409 : 500,
    );
  }
  return c.redirect("/login", 303);
});

auth.post("/logout", async (c) => {
  const user = c.get("user");
  if (user) {
    const now = nowIso();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL").bind(now, user.sessionId),
      c.env.DB.prepare("INSERT INTO audit_logs(user_id,company_id,action,entity_type,entity_id,reference,created_at) VALUES(?,?,'logout','User',?,?,?)")
        .bind(user.id, user.companyId ?? user.activeCompanyId, String(user.id), user.email, now),
    ]);
  }
  setCookies(c, clearSessionHeaders(c.req.raw));
  return c.redirect("/login", 303);
});

export default auth;
