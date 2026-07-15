import type { MiddlewareHandler } from "hono";
import type { AppVariables, Env } from "./types";
import { loadUser, verifyCsrf } from "./auth/session";

export const requestContext: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> = async (c, next) => {
  c.set("requestId", c.req.header("CF-Ray") ?? crypto.randomUUID());
  c.set("user", await loadUser(c));
  await next();
  c.header("X-Request-Id", c.get("requestId"));
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
};
export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> = async (c, next) => {
  const user = c.get("user");
  if (!user) {
    const requestUrl = new URL(c.req.url);
    const destination = `${requestUrl.pathname}${requestUrl.search}`;
    return c.redirect(`/login?next=${encodeURIComponent(destination)}`, 303);
  }
  if (user.forcePasswordChange && c.req.path !== "/logout") return c.redirect("/change-password", 303);
  await next();
};

export const requireCsrf: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> = async (c, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) return next();
  if (!await verifyCsrf(c)) return c.text("Invalid CSRF token", 403);
  await next();
};
