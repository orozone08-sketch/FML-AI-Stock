import type { AuthUser } from "../types";
import { can } from "../security/permissions";

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}
export function money(paise: unknown): string {
  const value = Number(paise ?? 0) / 100;
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function qty(milli: unknown): string {
  return (Number(milli ?? 0) / 1000).toLocaleString("en-IN", { maximumFractionDigits: 3 });
}

function nav(user: AuthUser): string {
  const links: Array<[string, string, string]> = [
    ["dashboard", "/dashboard/", "Dashboard"], ["items", "/masters/items", "Items"],
    ["customers", "/masters/customers", "Customers"], ["suppliers", "/masters/suppliers", "Suppliers"],
    ["purchase", "/transactions/purchase", "Purchases"], ["sale", "/transactions/sale", "Sales"],
    ["transfer", "/transactions/transfer", "Transfers"], ["opening", "/transactions/opening", "Opening"],
    ["payments", "/finance/payments", "Payments"], ["outstanding", "/finance/outstanding", "Outstanding"],
    ["reports", "/reports/", "Reports"], ["users", "/users/", "Users"],
  ];
  return links.filter(([module]) => can(user, module)).map(([, href, label]) => `<a href="${href}">${escapeHtml(label)}</a>`).join("");
}

export function layout(title: string, body: string, user: AuthUser | null, options: { message?: string; scripts?: string } = {}): string {
  const shell = user ? `<header><a class="brand" href="/dashboard/">FAstockFlow</a><nav>${nav(user)}</nav><span>${escapeHtml(user.name)}</span><form method="post" action="/logout"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><button>Logout</button></form></header>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · FAstockFlow</title><link rel="stylesheet" href="/static/app.css"></head><body>${shell}<main><h1>${escapeHtml(title)}</h1>${options.message ? `<div class="flash">${escapeHtml(options.message)}</div>` : ""}${body}</main>${options.scripts ?? ""}</body></html>`;
}

export function table(headers: string[], rows: unknown[][]): string {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell == null ? "" : String(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function formField(name: string, label: string, value: unknown = "", type = "text", required = false): string {
  return `<label>${escapeHtml(label)}<input type="${escapeHtml(type)}" name="${escapeHtml(name)}" value="${escapeHtml(value)}" ${required ? "required" : ""}></label>`;
}
