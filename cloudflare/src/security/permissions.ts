import type { Action, AuthUser, Role } from "../types";

export const MODULES = [
  "dashboard", "items", "customers", "suppliers", "companies", "stock_books",
  "purchase", "sale", "transfer", "opening", "payments", "outstanding",
  "due_alerts", "stock", "inter_company", "reports", "users", "audit",
] as const;

const ALL: Action[] = ["view", "create", "edit", "approve", "export", "deactivate"];
const perms = (entries: Record<string, Action[]>): Record<string, ReadonlySet<Action>> =>
  Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, new Set(value)]));

const rolePermissions: Record<Role, Record<string, ReadonlySet<Action>>> = {
  ADMIN: perms(Object.fromEntries(MODULES.map((module) => [module, ALL]))),
  STOCK: perms({
    dashboard: ["view"], items: ["view", "create", "edit", "deactivate"],
    suppliers: ["view", "create", "edit", "deactivate"], customers: ["view"],
    companies: ["view"], stock_books: ["view"], purchase: ["view", "create", "edit", "export"],
    sale: ["view"], transfer: ["view", "create", "edit", "approve", "export"],
    opening: ["view", "create"], outstanding: ["view"], due_alerts: ["view"],
    stock: ["view", "export"], inter_company: ["view", "export"], reports: ["view", "export"], audit: ["view"],
  }),
  SALES: perms({
    dashboard: ["view"], items: ["view"], suppliers: ["view"], customers: ["view", "create", "edit"],
    companies: ["view"], stock_books: ["view"], purchase: ["view"], sale: ["view", "create", "edit", "export"],
    transfer: ["view"], payments: ["view", "create"], outstanding: ["view", "export"], due_alerts: ["view"],
    stock: ["view"], inter_company: ["view"], reports: ["view", "export"],
  }),
  ACCOUNTS: perms({
    dashboard: ["view"], items: ["view"], suppliers: ["view"], customers: ["view"], companies: ["view"],
    stock_books: ["view"], purchase: ["view"], sale: ["view"], transfer: ["view"], opening: ["view", "create"],
    payments: ["view", "create", "export"], outstanding: ["view", "export"], due_alerts: ["view"], stock: ["view"],
    inter_company: ["view", "export"], reports: ["view", "export"], audit: ["view"],
  }),
  VIEWER: perms({
    dashboard: ["view"], items: ["view"], suppliers: ["view"], customers: ["view"], companies: ["view"],
    stock_books: ["view"], purchase: ["view"], sale: ["view"], transfer: ["view"], opening: ["view"],
    payments: ["view"], outstanding: ["view"], due_alerts: ["view"], stock: ["view"],
    inter_company: ["view"], reports: ["view"],
  }),
};

export function permissionsFor(role: Role): Record<string, ReadonlySet<Action>> {
  return Object.fromEntries(MODULES.map((module) => [module, new Set(rolePermissions[role][module] ?? [])]));
}
export function applyOverrides(
  base: Record<string, ReadonlySet<Action>>,
  overrides: Array<Record<string, unknown>>,
): Record<string, ReadonlySet<Action>> {
  const result = Object.fromEntries(Object.entries(base).map(([key, value]) => [key, new Set(value)])) as Record<string, Set<Action>>;
  for (const row of overrides) {
    const module = String(row.module ?? "");
    const target = result[module] ?? new Set<Action>();
    for (const action of ALL) {
      const value = row[`can_${action}`];
      if (value === 1 || value === true) target.add(action);
      if (value === 0 || value === false) target.delete(action);
    }
    result[module] = target;
  }
  return result;
}

export function can(user: AuthUser | null, module: string, action: Action = "view"): boolean {
  return Boolean(user?.permissions[module]?.has(action));
}
