import type { Env } from "../types";

export type ReferenceKind = "companies" | "items" | "stock-books" | "payment-modes";

const CACHE_VERSION = "v1";
const DEFAULT_TTL_SECONDS = 45;
const MEMORY_CACHE_LIMIT = 64;

type MemoryEntry = {
  expiresAt: number;
  rows: Record<string, unknown>[];
};

const memoryCache = new Map<string, MemoryEntry>();

function cacheRequest(env: Env, kind: ReferenceKind, scope = "all"): Request {
  const origin = new URL(env.SITE_URL || "https://fastockflow.invalid").origin;
  return new Request(`${origin}/__reference-cache/${CACHE_VERSION}/${kind}/${encodeURIComponent(scope)}`);
}

function remember<T extends Record<string, unknown>>(key: string, rows: T[], ttlSeconds: number): void {
  const now = Date.now();
  for (const [candidate, entry] of memoryCache) {
    if (entry.expiresAt <= now) memoryCache.delete(candidate);
  }
  if (!memoryCache.has(key) && memoryCache.size >= MEMORY_CACHE_LIMIT) {
    const oldest = memoryCache.keys().next().value as string | undefined;
    if (oldest) memoryCache.delete(oldest);
  }
  memoryCache.set(key, { expiresAt: now + ttlSeconds * 1_000, rows });
}

export async function cachedReferenceRows<T extends Record<string, unknown>>(
  env: Env,
  kind: ReferenceKind,
  scope: string,
  loader: () => Promise<T[]>,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<T[]> {
  const request = cacheRequest(env, kind, scope);
  const key = request.url;
  const memoryHit = memoryCache.get(key);
  if (memoryHit) {
    if (memoryHit.expiresAt > Date.now()) return memoryHit.rows as T[];
    memoryCache.delete(key);
  }

  let cache: Cache | undefined;
  if (typeof caches !== "undefined") {
    try {
      cache = await caches.open("fastockflow-reference-v1");
      const hit = await cache.match(request);
      if (hit) {
        const rows = await hit.json<T[]>();
        remember(key, rows, ttlSeconds);
        return rows;
      }
    } catch {
      // Cache availability must never affect accounting correctness.
    }
  }

  const rows = await loader();
  remember(key, rows, ttlSeconds);
  try {
    await cache?.put(request, Response.json(rows, {
      headers: { "Cache-Control": `public, max-age=${ttlSeconds}` },
    }));
  } catch {
    // A cache write is an optional latency/read optimization.
  }
  return rows;
}

export async function invalidateReferenceRows(
  env: Env,
  entries: Array<{ kind: ReferenceKind; scope?: string }>,
): Promise<void> {
  let cache: Cache | undefined;
  if (typeof caches !== "undefined") {
    try { cache = await caches.open("fastockflow-reference-v1"); } catch { /* best effort */ }
  }
  await Promise.all(entries.map(async ({ kind, scope = "all" }) => {
    const request = cacheRequest(env, kind, scope);
    memoryCache.delete(request.url);
    try { await cache?.delete(request); } catch { /* best effort */ }
  }));
}
