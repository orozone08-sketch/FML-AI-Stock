const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64url(value);
}

export async function sha256(value: string): Promise<string> {
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return encodeHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

function decodeHex(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return new Uint8Array();
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function encodeHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyWerkzeugPbkdf2(password: string, stored: string): Promise<boolean> {
  const [method, salt, expected] = stored.split("$");
  if (!method || !salt || !expected) return false;
  const [algorithm, digest, roundsText] = method.split(":");
  if (algorithm !== "pbkdf2" || digest !== "sha256") return false;
  const iterations = Number(roundsText || "1000000");
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const actual = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations }, key, 256));
  const wanted = decodeHex(expected);
  if (wanted.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= (actual[index] ?? 0) ^ (wanted[index] ?? 0);
  return difference === 0;
}

export async function createPbkdf2Hash(password: string, iterations = 600_000): Promise<string> {
  const salt = randomToken(12);
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations }, key, 256));
  return `pbkdf2:sha256:${iterations}$${salt}$${encodeHex(derived)}`;
}
