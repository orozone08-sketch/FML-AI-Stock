import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { companyCookie } from "../auth/session";
import { escapeHtml, layout } from "../views/html";
import { assetPaths } from "../generated/assets";
import { cachedReferenceRows } from "../cache/reference";

const company = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const safeNext = (value: string | undefined): string => value?.startsWith("/") && !value.startsWith("//") ? value : "/dashboard/";

company.get("/choose", async (c) => {
  const user = c.get("user")!;
  if (user.companyId) return c.redirect(safeNext(c.req.query("next")), 303);
  const rows = await cachedReferenceRows(c.env, "companies", "all", async () => (
    await c.env.DB.prepare("SELECT id,name,code FROM companies WHERE active=1 ORDER BY code").all<Record<string, unknown>>()
  ).results);
  const next = escapeHtml(safeNext(c.req.query("next")));
  const cards = rows.map((row) => {
    const code = String(row.code ?? "").toUpperCase();
    const logo = code === "AI" ? assetPaths.adityaLogo : code === "FML" ? assetPaths.firsttechLogo : assetPaths.icon;
    const active = Number(row.id) === user.activeCompanyId ? " active" : "";
    return `<form method="post" action="/company/select" class="company-choice-card${active}"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><input type="hidden" name="company_id" value="${row.id}"><input type="hidden" name="next" value="${next}"><button type="submit"><span class="company-choice-logo"><img src="${logo}" alt="${escapeHtml(row.name)}"></span><span class="company-choice-name">${escapeHtml(row.name)}</span><small>${escapeHtml(row.code)} workspace</small></button></form>`;
  }).join("");
  const empty = '<div class="panel"><p class="empty">No active companies are available.</p></div>';
  return c.html(layout("Choose Company", `<section class="company-choice-grid">${cards || empty}</section>`, user, { subtitle: "Select the company workspace for this session." }));
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
