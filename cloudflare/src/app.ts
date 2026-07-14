import { Hono } from "hono";
import type { AppVariables, Env } from "./types";
import { requestContext, requireAuth, requireCsrf } from "./middleware";
import auth from "./routes/auth";
import company from "./routes/company";
import dashboard from "./routes/dashboard";
import masters from "./routes/masters";
import users from "./routes/users";
import transactions from "./routes/transactions";
import finance from "./routes/finance";
import reports from "./routes/reports";
import customers from "./routes/customers";
import financeRead from "./routes/finance-read";
import { escapeHtml, layout } from "./views/html";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use("*", requestContext);

app.get("/healthz", (c) => c.json({ ok: true, service: "fastockflow", environment: c.env.APP_ENV, commit: globalThis.FASTOCKFLOW_COMMIT ?? "development" }));
app.get("/readyz", async (c) => {
  try {
    const schema = await c.env.DB.prepare("SELECT MAX(version) version FROM d1_migrations").first<{version:number}>().catch(() => null);
    await c.env.DB.prepare("SELECT 1 ok").first();
    return c.json({ ok: true, database: true, schema: schema?.version ?? null });
  } catch (error) {
    return c.json({ ok: false, database: false, error: error instanceof Error ? error.message : "D1 unavailable" }, 503);
  }
});

for (const prefix of ["/dashboard/*", "/company/*", "/masters/*", "/users/*", "/transactions/*", "/finance/*", "/reports/*", "/customers/*"]) {
  app.use(prefix, requireAuth);
}
for (const prefix of ["/company/*", "/masters/*", "/users/*", "/transactions/*", "/finance/*"]) {
  app.use(prefix, requireCsrf);
}
app.use("/logout", requireAuth, requireCsrf);

app.route("/", auth);
app.route("/company", company);
app.route("/dashboard", dashboard);
app.route("/masters", masters);
app.route("/users", users);
app.route("/transactions", transactions);
app.route("/finance", finance);
app.route("/finance", financeRead);
app.route("/reports", reports);
app.route("/customers", customers);

app.notFound((c) => c.html(layout("Not Found", `<p>The requested page was not found.</p><p><a href="/">Return home</a></p>`, c.get("user")), 404));
app.onError((error, c) => {
  console.error(JSON.stringify({ level: "error", requestId: c.get("requestId"), route: c.req.path, error: error.message }));
  return c.html(layout("Server Error", `<p>The request could not be completed. Reference: ${escapeHtml(c.get("requestId"))}</p>`, c.get("user")), 500);
});

declare global { var FASTOCKFLOW_COMMIT: string | undefined }
export default app;
