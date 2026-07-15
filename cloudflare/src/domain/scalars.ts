export type Money = bigint & { readonly __scale: "money" };
export type Quantity = bigint & { readonly __scale: "quantity" };
export type Rate = bigint & { readonly __scale: "rate" };
export type GstRate = bigint & { readonly __scale: "gst" };

export const MONEY_SCALE = 100n;
export const QUANTITY_SCALE = 1_000n;
export const RATE_SCALE = 10_000n;
export const GST_SCALE = 100n; // basis points per percent; 18% = 1800

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("Denominator must be positive.");
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  return sign * (quotient + (remainder * 2n >= denominator ? 1n : 0n));
}

function parseScaled(value: string | number | bigint, scale: bigint, label: string): bigint {
  if (typeof value === "bigint") return value;
  const text = String(value).replaceAll(",", "").trim();
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) throw new TypeError(`Invalid ${label} value.`);
  const sign = match[1] === "-" ? -1n : 1n;
  const digits = scale.toString().length - 1;
  const fraction = match[3] ?? "";
  const kept = (fraction.slice(0, digits) + "0".repeat(digits)).slice(0, digits);
  let result = BigInt(match[2]!) * scale + BigInt(kept || "0");
  const discarded = fraction.slice(digits);
  if (discarded.length && discarded.charAt(0) >= "5") result += 1n;
  return sign * result;
}

export const money = (value: string | number | bigint): Money => parseScaled(value, MONEY_SCALE, "money") as Money;
export const quantity = (value: string | number | bigint): Quantity => parseScaled(value, QUANTITY_SCALE, "quantity") as Quantity;
export const rate = (value: string | number | bigint): Rate => parseScaled(value, RATE_SCALE, "rate") as Rate;
export const gstRate = (value: string | number | bigint): GstRate => parseScaled(value, GST_SCALE, "GST") as GstRate;

export function checkedD1Integer(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError("Scaled integer exceeds D1/JavaScript safe integer range.");
  return result;
}

export function multiplyQuantityRate(qty: Quantity, unitRate: Rate): Money {
  return roundHalfUp(qty * unitRate * MONEY_SCALE, QUANTITY_SCALE * RATE_SCALE) as Money;
}

export function applyGst(subtotal: Money, percent: GstRate): Money {
  return roundHalfUp(subtotal * percent, 100n * GST_SCALE) as Money;
}

export function lineTotals(qty: Quantity, unitRate: Rate, percent: GstRate, taxable = true) {
  const subtotal = multiplyQuantityRate(qty, unitRate);
  const gst = (taxable ? applyGst(subtotal, percent) : 0n) as Money;
  return { subtotal, gst, total: (subtotal + gst) as Money };
}

export function formatScaled(value: bigint, scale: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const digits = scale.toString().length - 1;
  return `${sign}${absolute / scale}.${(absolute % scale).toString().padStart(digits, "0")}`;
}

export const paymentStatus = (total: Money, paid: Money): "PAID" | "UNPAID" | "PARTIAL" =>
  total - paid <= 0n ? "PAID" : paid <= 0n ? "UNPAID" : "PARTIAL";

export function positive<T extends bigint>(value: T, label: string): T {
  if (value <= 0n) throw new RangeError(`${label} must be greater than zero.`);
  return value;
}
