export interface Page<T> { items: T[]; nextCursor: string | null }

export function intParam(value: string | undefined | null, fallback = 0): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}
export function isoDate(value: string | undefined | null): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export function nowIso(): string { return new Date().toISOString(); }

export function rowsRead(meta: unknown): number {
  return Number((meta as { rows_read?: number } | undefined)?.rows_read ?? 0);
}

export function rowsWritten(meta: unknown): number {
  return Number((meta as { rows_written?: number } | undefined)?.rows_written ?? 0);
}

export function parseCursor(value: string | undefined): [string, number] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/"))) as [string, number];
    return typeof parsed[0] === "string" && Number.isSafeInteger(parsed[1]) ? parsed : null;
  } catch { return null; }
}

export function makeCursor(sort: string, id: number): string {
  return btoa(JSON.stringify([sort, id])).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
