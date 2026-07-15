export interface CompanyScope { activeCompanyId: number | null }
export interface ReportFilters {
  companyId?: number;
  from?: string;
  to?: string;
  cursorDate?: string;
  cursorId?: number;
  limit?: number;
  itemId?: number;
  stockBookId?: number;
  customerId?: number;
  supplierId?: number;
  month?: string;
  query?: string;
}
export interface ReportResult<T = Record<string, unknown>> {
  rows: T[];
  hasMore: boolean;
  nextCursor: { date: string; id: number } | null;
}
export interface ReportDefinition {
  name: string;
  title: string;
  dateColumn?: string;
  companyColumn?: string;
  sql: string;
}
