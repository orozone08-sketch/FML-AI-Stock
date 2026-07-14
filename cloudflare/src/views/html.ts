import type { AuthUser } from "../types";
import { can } from "../security/permissions";
import { assetPaths } from "../generated/assets";

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
  const links: Array<[string, string, string, string]> = [
    ["dashboard", "/dashboard", "Dashboard", "layout-dashboard"], ["items", "/masters/items", "Items", "gem"],
    ["customers", "/masters/customers", "Customers", "users"], ["suppliers", "/masters/suppliers", "Suppliers", "truck"],
    ["purchase", "/transactions/purchase", "Purchase", "shopping-bag"], ["sale", "/transactions/sale", "Sale", "receipt-text"],
    ["transfer", "/transactions/transfer", "Transfer", "arrow-left-right"], ["opening", "/transactions/opening", "Opening", "folder-open"],
    ["payments", "/finance/payments", "Payments", "credit-card"], ["outstanding", "/finance/outstanding", "Outstanding", "wallet-cards"],
    ["reports", "/reports", "Reports", "chart-no-axes-combined"], ["users", "/users", "Users", "user-cog"],
  ];
  return links.filter(([module]) => can(user, module)).map(([, href, label, icon]) => `<a data-nav-icon="${icon}" href="${href}">${escapeHtml(label)}</a>`).join("");
}

function documentHead(title: string): string {
  return `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · FAstockFlow</title><link rel="icon" href="/static/img/fastockflow-icon.png"><link rel="stylesheet" href="${assetPaths.css}"></head>`;
}

export function layout(title: string, body: string, user: AuthUser | null, options: { message?: string; scripts?: string } = {}): string {
  const message = options.message ? `<div class="flash info">${escapeHtml(options.message)}</div>` : "";
  if (!user) return `<!doctype html><html lang="en">${documentHead(title)}<body><main class="main public-main"><header class="topbar"><div class="topbar-copy"><div class="topbar-title-row"><h1>${escapeHtml(title)}</h1></div><p>Secure stock, billing, payments and company control</p></div></header><div class="content-container">${message}<section class="panel narrow">${body}</section></div></main><script src="${assetPaths.js}"></script>${options.scripts ?? ""}</body></html>`;
  return `<!doctype html><html lang="en">${documentHead(title)}<body><div class="app-shell"><aside class="sidebar" aria-label="Primary navigation"><button class="sidebar-collapse-button" type="button" data-sidebar-toggle aria-label="Minimize sidebar"><span data-icon="panel-left"></span></button><button class="sidebar-hide-button" type="button" data-sidebar-hide aria-label="Hide sidebar"><span data-icon="chevrons-left"></span></button><a class="brand" href="/dashboard"><span class="brand-mark logo-mark"><img src="/static/img/fastockflow-icon.png" alt="FAstockFlow"></span><span><strong>FAstockFlow</strong><small>Jewellery Factory ERP</small></span></a><nav class="nav">${nav(user)}</nav><div class="sidebar-footer"><div class="user-chip">${escapeHtml(user.name)} · ${escapeHtml(user.role)}</div><form method="post" action="/logout"><input type="hidden" name="csrf_token" value="${escapeHtml(user.csrfToken)}"><button class="ghost-button full" type="submit">Logout</button></form></div></aside><button class="sidebar-peek-button" type="button" data-sidebar-show aria-label="Show sidebar"><span data-icon="panel-right"></span></button><main class="main" id="main-content"><header class="topbar"><div class="topbar-copy"><nav class="breadcrumbs"><a href="/dashboard">Home</a><span>/</span><span aria-current="page">${escapeHtml(title)}</span></nav><div class="topbar-title-row"><button class="back-button" type="button" data-back-button data-back-fallback="/dashboard"><span data-icon="arrow-left"></span><span>Back</span></button><h1>${escapeHtml(title)}</h1></div><p>Real-time stock, FIFO, payments and inter-company control</p></div><div class="topbar-actions"><label class="global-search"><span data-icon="search"></span><input type="search" placeholder="Search this page" data-global-search></label><a class="quick-action primary" href="/transactions/sale">Sale</a><a class="quick-action" href="/transactions/purchase">Purchase</a><button class="theme-toggle" type="button" data-theme-toggle aria-label="Toggle dark mode"><span data-icon="moon"></span></button><div class="user-chip">${escapeHtml(user.name)} · ${escapeHtml(user.role)}</div></div></header><div class="content-container">${message}${body}</div></main></div><script src="${assetPaths.js}"></script>${options.scripts ?? ""}</body></html>`;
}

export function authLayout(title: string, panel: string, message = ""): string {
  return `<!doctype html><html lang="en">${documentHead(title)}<body class="auth-body"><main class="login-page auth-page"><section class="auth-shell"><aside class="auth-hero"><div class="auth-product-mark"><img src="/static/img/fastockflow-icon.png" alt="FAstockFlow"><span>FAstockFlow</span></div><div class="auth-hero-copy"><span class="auth-kicker">Jewellery Factory ERP</span><h1>Secure stock, billing, payment, and company control.</h1><p>Choose your company workspace and continue with the login ID assigned to that company.</p></div><div class="auth-trust-grid"><span><strong>FIFO</strong>stock ledgers</span><span><strong>GST/Cash</strong>workflows</span><span><strong>Audit</strong>entry tracking</span></div></aside><section class="auth-panel">${message ? `<div class="flash info">${escapeHtml(message)}</div>` : ""}${panel}</section></section></main><script src="${assetPaths.js}"></script></body></html>`;
}

export function table(headers: string[], rows: unknown[][]): string {
  return `<section class="panel"><div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell == null ? "" : String(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>`;
}

export function formField(name: string, label: string, value: unknown = "", type = "text", required = false): string {
  return `<label class="form-field">${escapeHtml(label)}<input type="${escapeHtml(type)}" name="${escapeHtml(name)}" value="${escapeHtml(value)}" ${required ? "required" : ""}></label>`;
}
