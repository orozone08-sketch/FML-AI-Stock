import type { CompanyScope, ReportFilters } from "./types";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const MAX_RANGE_DAYS = 366;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function normalizeFilters(input: ReportFilters, scope: CompanyScope): Required<Pick<ReportFilters, "limit">> & ReportFilters {
  const result: ReportFilters & { limit: number } = { ...input, limit: Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(input.limit ?? DEFAULT_PAGE_SIZE))) };
  for (const key of ["from", "to", "cursorDate"] as const) {
    const value = result[key];
    if (value && !validDate(value)) throw new RangeError(`Invalid ${key} date`);
  }
  if (result.from && result.to) {
    if (result.from > result.to) throw new RangeError("from must not be after to");
    const days = (Date.parse(`${result.to}T00:00:00Z`) - Date.parse(`${result.from}T00:00:00Z`)) / 86_400_000;
    if (days > MAX_RANGE_DAYS) throw new RangeError(`Date range exceeds ${MAX_RANGE_DAYS} days`);
  }
  if (scope.activeCompanyId !== null) {
    if (result.companyId !== undefined && result.companyId !== scope.activeCompanyId) throw new RangeError("Company is outside the active scope");
    result.companyId = scope.activeCompanyId;
  }
  for (const key of ["companyId", "cursorId", "itemId", "stockBookId", "customerId", "supplierId"] as const) {
    const value = result[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new RangeError(`Invalid ${key}`);
  }
  if (result.cursorDate !== undefined && result.cursorId === undefined) throw new RangeError("cursorDate requires cursorId");
  if (result.cursorKey !== undefined && !/^\d{10}:\d{10}:\d{10}$/.test(result.cursorKey)) throw new RangeError("Invalid cursorKey");
  if (result.query !== undefined) result.query = result.query.trim().slice(0, 100);
  if (result.status !== undefined && !["UNPAID", "PARTIAL", "PAID", "ADVANCE"].includes(result.status)) throw new RangeError("Invalid status");
  return result;
}
