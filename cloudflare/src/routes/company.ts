import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { companyCookie } from "../auth/session";
import { escapeHtml, layout } from "../views/html";

const company = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const safeNext = (value: string | undefined): string => value?.startsWith("/") && !value.startsWith("//") ? value : "/dashboard/";

company.get("/choose", async (c) => {
  const user = c.get("user")!;
  if (user.companyId) return c.redirect(safeNext(c.req.query("next")), 303);
  const rows = await c.env.DB.prepare("SELECT id,name,code FROM companies WHERE active=1 ORDER BY code LIMIT 20").all<Record<string, unknown>>();
  const options = rows.results.map((row) => `<option value="${row.id}">${escapeHtml(row.code)} — ${escapeHtml(row.name)}</option>`).join("");
  return c.html(layout("Choose Company", `<form method="post" action="/company/select"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><input type="hidden" name="next" value="${escapeHtml(safeNext(c.req.query("next")))}"><select name="company_id" required>${options}</select><button>Use company</button></form><form method="post" action="/company/all"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><input type="hidden" name="next" value="${escapeHtml(safeNext(c.req.query("next")))}"><button>Show all companies</button></form>`, user));
});

company.post("/select", async (c) => {
  const user = c.get("user")!;
  if (user.companyId) return c.redirect("/dashboard/", 303);
  const body = await c.req.parseBody();
  const id = Number.parseInt(String(body.company_id ?? ""), 10);
  const row = await c.env.DB.prepare("SELECT id FROM companies WHERE id=? AND active=1").bind(id).first();
  if (!row) return c.redirect("/company/choose", 303);
  c.header("Set-Cookie", await companyCookie(id, c.req.raw, c.env.SESSION_HMAC_KEY));
  return c.redirect(safeNext(String(body.next ?? "")), 303);
});

company.post("/all", async (c) => {
  const user = c.get("user")!;
  if (user.role !== "ADMIN" || user.companyId) return c.text("Forbidden", 403);
  const body = await c.req.parseBody();
  c.header("Set-Cookie", await companyCookie(null, c.req.raw, c.env.SESSION_HMAC_KEY));
  return c.redirect(safeNext(String(body.next ?? "")), 303);
});

export default company;
