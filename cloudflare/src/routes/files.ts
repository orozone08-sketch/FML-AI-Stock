import { Hono, type Context } from "hono";
import type { AppVariables, Env } from "../types";
import { randomToken } from "../security/crypto";

const files = new Hono<{ Bindings: Env; Variables: AppVariables }>();
type Row = Record<string, unknown>;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const hex = (bytes: Uint8Array) => [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
const allowed = (user: NonNullable<AppVariables["user"]>, companyId: number) => user.activeCompanyId === null || user.activeCompanyId === companyId;

function positiveId(value: string | undefined) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function readyObject(c: Context<{ Bindings: Env; Variables: AppVariables }>) {
  const id = positiveId(c.req.param("id"));
  if (id === null) return null;
  const row = await c.env.DB.prepare("SELECT * FROM r2_objects WHERE id=? AND lifecycle_state='READY'").bind(id).first<Row>();
  return row ? { id, row } : null;
}

function objectHeaders(row: Row, object: R2Object, contentLength: number) {
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="fastockflow-file-${String(row.id)}"`,
    "Content-Length": String(contentLength),
    "Content-Type": String(row.content_type),
    ETag: object.httpEtag,
  });
  return headers;
}

function requestedRange(header: string | undefined, size: number): R2Range | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return "invalid";
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { suffix: Math.min(suffix, size) };
  }
  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedEnd) || offset < 0 || offset >= size || requestedEnd < offset) return "invalid";
  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1 };
}

function rangeBounds(range: R2Range, size: number) {
  if ("suffix" in range) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = range.offset ?? 0;
  return { offset, length: range.length ?? size - offset };
}

const upload = async (c: Context<{ Bindings: Env; Variables: AppVariables }>) => {
  const user = c.get("user")!;
  const companyId = Number(c.req.header("X-Company-Id") ?? user.activeCompanyId);
  const length = Number(c.req.header("Content-Length") ?? 0);
  if (!Number.isSafeInteger(companyId) || companyId <= 0 || !allowed(user, companyId)) return c.text("Forbidden", 403);
  if (user.role === "VIEWER") return c.text("Forbidden", 403);
  if (!Number.isSafeInteger(length) || length <= 0) return c.text("Content-Length is required.", 411);
  if (length > MAX_FILE_BYTES) return c.text("File exceeds the 10 MiB limit.", 413);

  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength !== length) return c.text("Content length mismatch.", 400);
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  const key = `companies/${companyId}/${randomToken(24)}`;
  const createdAt = new Date().toISOString();
  const requestedType = (c.req.header("Content-Type") ?? "application/octet-stream").slice(0, 255);
  const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(requestedType) ? requestedType : "application/octet-stream";
  const inserted = await c.env.DB.prepare("INSERT INTO r2_objects(object_key,company_id,owner_user_id,content_type,size_bytes,sha256,lifecycle_state,created_at) VALUES(?,?,?,?,?,?,'PENDING',?)")
    .bind(key, companyId, user.id, contentType, length, digest, createdAt).run();
  const id = Number(inserted.meta.last_row_id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Could not allocate file metadata ID.");

  try {
    await c.env.FILES.put(key, bytes, { httpMetadata: { contentType }, customMetadata: { sha256: digest } });
    const ready = await c.env.DB.prepare("UPDATE r2_objects SET lifecycle_state='READY',ready_at=? WHERE id=? AND lifecycle_state='PENDING'")
      .bind(new Date().toISOString(), id).run();
    if (Number(ready.meta.changes ?? 0) !== 1) {
      await c.env.FILES.delete(key);
      throw new Error("File upload lost its pending lifecycle claim.");
    }
  } catch (error) {
    await c.env.DB.prepare("UPDATE r2_objects SET lifecycle_state='ORPHANED',deleted_at=? WHERE id=? AND lifecycle_state='PENDING'")
      .bind(new Date().toISOString(), id).run();
    throw error;
  }
  return c.json({ id, sizeBytes: length, sha256: digest }, 201);
};

files.post("/", upload);
files.post("/upload", upload);
files.get("/status", async (c) => {
  await c.env.FILES.list({ limit: 1 });
  return c.json({ ok: true, storage: true });
});

files.get("/:id", async (c) => {
  const record = await readyObject(c);
  if (!record) return c.notFound();
  const user = c.get("user")!;
  if (!allowed(user, Number(record.row.company_id))) return c.text("Forbidden", 403);

  // Hono dispatches HEAD to the matching GET route. Handle it before get() so
  // R2 returns metadata without reading the object body.
  if (c.req.method === "HEAD") {
    const object = await c.env.FILES.head(String(record.row.object_key));
    if (!object) return c.notFound();
    const headers = objectHeaders(record.row, object, object.size);
    const ifNoneMatch = c.req.header("If-None-Match");
    if (ifNoneMatch && (ifNoneMatch.trim() === "*" || ifNoneMatch.split(",").some((tag) => tag.trim().replace(/^W\//, "") === object.httpEtag))) {
      headers.delete("Content-Length");
      return new Response(null, { status: 304, headers });
    }
    return new Response(null, { status: 200, headers });
  }

  const size = Number(record.row.size_bytes);
  const range = requestedRange(c.req.header("Range"), size);
  if (range === "invalid") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  const options: R2GetOptions = {};
  if (range) options.range = range;
  if (c.req.header("If-None-Match")) options.onlyIf = c.req.raw.headers;
  const object = await c.env.FILES.get(String(record.row.object_key), options) as R2ObjectBody | R2Object | null;
  if (!object) return c.notFound();
  if (!("body" in object)) {
    const headers = objectHeaders(record.row, object, object.size);
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }

  const bounds = range ? rangeBounds(range, size) : null;
  const headers = objectHeaders(record.row, object, bounds?.length ?? object.size);
  if (bounds) headers.set("Content-Range", `bytes ${bounds.offset}-${bounds.offset + bounds.length - 1}/${size}`);
  return new Response(object.body, { status: bounds ? 206 : 200, headers });
});

files.delete("/:id", async (c) => {
  const record = await readyObject(c);
  if (!record) return c.notFound();
  const user = c.get("user")!;
  if (!allowed(user, Number(record.row.company_id)) || (user.role !== "ADMIN" && Number(record.row.owner_user_id) !== user.id)) return c.text("Forbidden", 403);

  const deletedAt = new Date().toISOString();
  const claimed = await c.env.DB.prepare("UPDATE r2_objects SET lifecycle_state='SOFT_DELETED',deleted_at=? WHERE id=? AND lifecycle_state='READY'")
    .bind(deletedAt, record.id).run();
  if (Number(claimed.meta.changes ?? 0) !== 1) return c.text("File state changed; retry the request.", 409);
  try {
    await c.env.FILES.delete(String(record.row.object_key));
  } catch (error) {
    await c.env.DB.prepare("UPDATE r2_objects SET lifecycle_state='READY',deleted_at=NULL WHERE id=? AND lifecycle_state='SOFT_DELETED'")
      .bind(record.id).run();
    throw error;
  }
  return c.body(null, 204);
});

export default files;
