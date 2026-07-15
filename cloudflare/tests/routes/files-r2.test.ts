import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import files from "../../src/routes/files";
import type { AppVariables, AuthUser, Env } from "../../src/types";

type Row = Record<string, unknown>;

const user: AuthUser = {
  id: 7,
  name: "File Owner",
  email: "owner@example.invalid",
  role: "ADMIN",
  companyId: 3,
  activeCompanyId: 3,
  forcePasswordChange: false,
  permissions: {},
  csrfToken: "csrf",
  sessionId: 1,
};

function routeApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => { c.set("user", user); await next(); });
  app.route("/files", files);
  return app;
}

function dbFor(row: Row, events: string[], failRestore = false) {
  return {
    prepare(query: string) {
      return {
        params: [] as unknown[],
        bind(...params: unknown[]) { this.params = params; return this; },
        async first() { return row; },
        async run() {
          if (query.includes("SOFT_DELETED")) {
            const restore = query.includes("SET lifecycle_state='READY'");
            events.push(restore ? "db:restore" : "db:claim");
            return { success: true, meta: { changes: restore && failRestore ? 0 : 1 } };
          }
          return { success: true, meta: { changes: 1, last_row_id: 10 } };
        },
      };
    },
  } as unknown as D1Database;
}

function r2Object(body: ReadableStream | null, size = 6): R2ObjectBody | R2Object {
  const base = {
    key: "companies/3/file",
    version: "1",
    size,
    etag: "abc",
    httpEtag: '"abc"',
    checksums: {},
    uploaded: new Date("2026-07-15T00:00:00.000Z"),
    storageClass: "Standard",
    writeHttpMetadata() {},
  };
  return body ? { ...base, body, bodyUsed: false, arrayBuffer: async () => new ArrayBuffer(0), bytes: async () => new Uint8Array(), text: async () => "", json: async () => ({}), blob: async () => new Blob() } as unknown as R2ObjectBody : base as unknown as R2Object;
}

const metadata = { id: 4, object_key: "companies/3/file", company_id: 3, owner_user_id: 7, content_type: "text/plain", size_bytes: 6 };

describe("private R2 file routes", () => {
  it("serves HEAD metadata without downloading the object body", async () => {
    let heads = 0;
    const env = {
      DB: dbFor(metadata, []),
      FILES: { head: async () => { heads++; return r2Object(null); } },
    } as unknown as Env;

    const response = await routeApp().request("http://local/files/4", { method: "HEAD" }, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"abc"');
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await response.text()).toBe("");
    expect(heads).toBe(1);
  });

  it("claims the D1 lifecycle state before deleting bytes", async () => {
    const events: string[] = [];
    const env = {
      DB: dbFor(metadata, events),
      FILES: { delete: async () => { events.push("r2:delete"); } },
    } as unknown as Env;

    const response = await routeApp().request("http://local/files/4", { method: "DELETE" }, env);

    expect(response.status).toBe(204);
    expect(events).toEqual(["db:claim", "r2:delete"]);
  });

  it("compensates D1 back to READY when the R2 delete fails", async () => {
    const events: string[] = [];
    const env = {
      DB: dbFor(metadata, events),
      FILES: { delete: async () => { events.push("r2:delete"); throw new Error("R2 unavailable"); } },
    } as unknown as Env;

    const response = await routeApp().request("http://local/files/4", { method: "DELETE" }, env);

    expect(response.status).toBe(500);
    expect(events).toEqual(["db:claim", "r2:delete", "db:restore"]);
  });

  it("serves one byte range with correct private response metadata", async () => {
    let getOptions: R2GetOptions | undefined;
    const env = {
      DB: dbFor(metadata, []),
      FILES: { get: async (_key: string, options: R2GetOptions) => { getOptions = options; return r2Object(new Response("bcd").body, 6); } },
    } as unknown as Env;

    const response = await routeApp().request("http://local/files/4", { headers: { Range: "bytes=1-3" } }, env);

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 1-3/6");
    expect(response.headers.get("Content-Length")).toBe("3");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="fastockflow-file-4"');
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getOptions?.range).toEqual({ offset: 1, length: 3 });
  });

  it("returns 304 without a body when R2 rejects If-None-Match", async () => {
    const env = {
      DB: dbFor(metadata, []),
      FILES: { get: async () => r2Object(null) },
    } as unknown as Env;

    const response = await routeApp().request("http://local/files/4", { headers: { "If-None-Match": '"abc"' } }, env);

    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe('"abc"');
    expect(await response.text()).toBe("");
  });

  it("rejects unsatisfiable ranges without reading R2", async () => {
    let reads = 0;
    const env = {
      DB: dbFor(metadata, []),
      FILES: { get: async () => { reads++; return null; } },
    } as unknown as Env;

    const response = await routeApp().request("http://local/files/4", { headers: { Range: "bytes=9-10" } }, env);

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */6");
    expect(reads).toBe(0);
  });

  it("deletes uploaded bytes when maintenance won the pending lifecycle claim", async () => {
    const events: string[] = [];
    const db = {
      prepare(query: string) {
        return {
          bind() { return this; },
          async run() {
            if (query.startsWith("INSERT INTO r2_objects")) return { success: true, meta: { last_row_id: 12, changes: 1 } };
            if (query.includes("SET lifecycle_state='READY'")) { events.push("db:ready-lost"); return { success: true, meta: { changes: 0 } }; }
            if (query.includes("SET lifecycle_state='ORPHANED'")) { events.push("db:orphan-noop"); return { success: true, meta: { changes: 0 } }; }
            return { success: true, meta: { changes: 0 } };
          },
        };
      },
    } as unknown as D1Database;
    const env = {
      DB: db,
      FILES: {
        put: async () => { events.push("r2:put"); return r2Object(null); },
        delete: async () => { events.push("r2:delete"); },
      },
    } as unknown as Env;

    const response = await routeApp().request("http://local/files/upload", {
      method: "POST",
      headers: { "Content-Length": "1", "Content-Type": "text/plain", "X-Company-Id": "3" },
      body: "x",
    }, env);

    expect(response.status).toBe(500);
    expect(events).toEqual(["r2:put", "db:ready-lost", "r2:delete", "db:orphan-noop"]);
  });
});
