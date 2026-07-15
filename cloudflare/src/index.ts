import app from "./app";
import { runScheduledMaintenance } from "./maintenance";
import type { Env } from "./types";
export { AccountingCoordinator } from "./durable-objects/accounting-coordinator";

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledMaintenance(env).then((result) => {
      console.log(JSON.stringify({ level: "info", event: "scheduled-maintenance", ...result }));
    }).catch((error: unknown) => {
      console.error(JSON.stringify({ level: "error", event: "scheduled-maintenance", error: error instanceof Error ? error.message : String(error) }));
      throw error;
    }));
  },
};
