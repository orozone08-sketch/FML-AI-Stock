import type { Context } from "hono";
import type { AppVariables, AuthUser, Env, Role } from "../types";
import { applyOverrides, permissionsFor } from "../security/permissions";
import { hmac, randomToken, sha256 } from "../security/crypto";
import { nowIso } from "../db/helpers";

const SESSION_COOKIE = "fastock_session";
const CSRF_COOKIE = "fastock_csrf";
const COMPANY_COOKIE = "fastock_company";

function cookies(request: Request): Record<string, string> {
  const header = request.headers.get("Cookie") ?? "";
  const result: Record<string, string> = {};
  for (const entry of header.split(";")) {
    const [key, value] = entry.trim().split("=", 2);
    if (key && value) result[key] = decodeURIComponent(value);
  }
  return result;
}

function cookie(name: string, value: string, options: { httpOnly?: boolean; maxAge?: number; secure?: boolean } = {}): string {
  return [
    `${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax",
    options.httpOnly ? "HttpOnly" : "", options.secure === false ? "" : "Secure",
    options.maxAge == null ? "" : `Max-Age=${options.maxAge}`,
  ].filter(Boolean).join("; ");
}

export async function createSession(db: D1Database, userId: number, request: Request, remember = false): Promise<{ headers: string[]; csrf: string }> {
  const token = randomToken();
  const csrf = randomToken();
  const now = nowIso();
  const lifetime = remember ? 60 * 60 * 24 * 30 : 60 * 60 * 12;
  const expires = new Date(Date.now() + lifetime * 1000).toISOString();
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const ua = request.headers.get("User-Agent") ?? "unknown";
  await db.prepare(`INSERT INTO sessions
    (token_digest,csrf_digest,user_id,created_at,last_seen_at,expires_at,ip_prefix_digest,user_agent_digest)
    VALUES(?,?,?,?,?,?,?,?)`).bind(await sha256(token), await sha256(csrf), userId, now, now, expires, await sha256(ip), await sha256(ua)).run();
  const secure = new URL(request.url).protocol === "https:";
  return { csrf, headers: [cookie(SESSION_COOKIE, token, { httpOnly: true, maxAge: lifetime, secure }), cookie(CSRF_COOKIE, csrf, { maxAge: lifetime, secure })] };
}

export async function revokeSession(db: D1Database, sessionId: number): Promise<void> {
  await db.prepare("UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL").bind(nowIso(), sessionId).run();
}

export function clearSessionHeaders(request: Request): string[] {
  const secure = new URL(request.url).protocol === "https:";
  return [cookie(SESSION_COOKIE, "", { httpOnly: true, maxAge: 0, secure }), cookie(CSRF_COOKIE, "", { maxAge: 0, secure }), cookie(COMPANY_COOKIE, "", { maxAge: 0, secure })];
}

async function activeCompany(raw: string | undefined, userCompanyId: number | null, role: Role, secret: string): Promise<number | null> {
  if (userCompanyId) return userCompanyId;
  if (!raw || role !== "ADMIN") return null;
  const [idText, signature] = raw.split(".");
  const id = Number.parseInt(idText ?? "", 10);
  if (!Number.isSafeInteger(id) || !idText || !signature || await hmac(idText, secret) !== signature) return null;
  return id;
}

export async function companyCookie(companyId: number | null, request: Request, secret: string): Promise<string> {
  const secure = new URL(request.url).protocol === "https:";
  if (!companyId) return cookie(COMPANY_COOKIE, "", { maxAge: 0, secure });
  return cookie(COMPANY_COOKIE, `${companyId}.${await hmac(String(companyId), secret)}`, { maxAge: 60 * 60 * 12, secure });
}

export async function loadUser(c: Context<{ Bindings: Env; Variables: AppVariables }>): Promise<AuthUser | null> {
  const jar = cookies(c.req.raw);
  const token = jar[SESSION_COOKIE];
  const csrf = jar[CSRF_COOKIE];
  if (!token || !csrf) return null;
  const now = nowIso();
  const row = await c.env.DB.prepare(`SELECT s.id AS session_id,s.csrf_digest,u.id,u.name,u.email,u.role,u.company_id,u.force_password_change
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_digest=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.active=1 LIMIT 1`)
    .bind(await sha256(token), now).first<Record<string, unknown>>();
  if (!row || await sha256(csrf) !== row.csrf_digest) return null;
  const role = String(row.role) as Role;
  const overrides = await c.env.DB.prepare("SELECT module,can_view,can_create,can_edit,can_approve,can_export,can_deactivate FROM permission_overrides WHERE user_id=?")
    .bind(row.id).all<Record<string, unknown>>();
  return {
    id: Number(row.id), name: String(row.name), email: String(row.email), role,
    companyId: row.company_id == null ? null : Number(row.company_id),
    activeCompanyId: await activeCompany(jar[COMPANY_COOKIE], row.company_id == null ? null : Number(row.company_id), role, c.env.SESSION_HMAC_KEY),
    forcePasswordChange: Boolean(row.force_password_change),
    permissions: applyOverrides(permissionsFor(role), overrides.results), csrfToken: csrf, sessionId: Number(row.session_id),
  };
}

export async function verifyCsrf(c: Context<{ Bindings: Env; Variables: AppVariables }>): Promise<boolean> {
  const user = c.get("user");
  if (!user) return false;
  const contentType = c.req.header("Content-Type") ?? "";
  let supplied: unknown;
  if (contentType.includes("application/json")) {
    const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    supplied = body.csrf_token;
  }
  else supplied = (await c.req.parseBody()).csrf_token;
  return typeof supplied === "string" && supplied === user.csrfToken;
}
