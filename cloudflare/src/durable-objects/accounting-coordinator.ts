import { AccountingHandler, type AccountingEnvelope } from "../accounting";
import type { Env } from "../types";

export class AccountingCoordinator implements DurableObject {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return Promise.resolve(Response.json({ error: "Method not allowed" }, { status: 405 }));
    const run = this.tail.then(() => this.handle(request));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async handle(request: Request): Promise<Response> {
    try {
      const envelope = await request.json<AccountingEnvelope>();
      if (!envelope.type || !envelope.userId || !envelope.idempotencyKey || !envelope.requestDigest) return Response.json({ error: "Invalid command envelope." }, { status: 400 });
      const result = await new AccountingHandler(this.env.DB).execute(envelope);
      return Response.json(result, { status: result.replayed ? 200 : 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Accounting command failed.";
      const conflict = /Idempotency|already in progress|constraint|UNIQUE/i.test(message);
      return Response.json({ error: message }, { status: conflict ? 409 : 422 });
    }
  }
}
