const MONEY = /(?:^|_)(?:amount|total|balance|value|cost|profit|debit|credit)_paise$|_paise$/;
const QUANTITY = /_milliunits$/;
const RATE = /_ten_thousandths$/;

export function formatScaled(key: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "number" && typeof value !== "bigint") return String(value);
  const integer = BigInt(value);
  if (MONEY.test(key)) return fixed(integer, 100n, 2);
  if (QUANTITY.test(key)) return fixed(integer, 1000n, 3).replace(/\.?0+$/, "");
  if (RATE.test(key)) return fixed(integer, 10000n, 4).replace(/\.?0+$/, "");
  if (key.endsWith("basis_points")) return fixed(integer, 100n, 2).replace(/\.?0+$/, "");
  return String(value);
}
function fixed(value: bigint, scale: bigint, places: number): string {
  const negative = value < 0n; const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / scale}.${(absolute % scale).toString().padStart(places,"0")}`;
}

function csvCell(value: string): string { return /[",\r\n]/.test(value) ? `"${value.replaceAll('"','""')}"` : value; }

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]!);
  return `\uFEFF${headers.map(csvCell).join(",")}\r\n${rows.map((row) => headers.map((key) => csvCell(formatScaled(key,row[key]))).join(",")).join("\r\n")}\r\n`;
}

export function printableRows(rows: Record<string, unknown>[]): { headers: string[]; rows: string[][] } {
  const headers = rows.length ? Object.keys(rows[0]!) : [];
  return { headers, rows: rows.map((row) => headers.map((key) => formatScaled(key,row[key]))) };
}
