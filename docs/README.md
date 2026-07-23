# FAstockFlow documentation

Use this index to avoid treating an old plan as current production state.

## Start here

1. [Project continuity](PROJECT_CONTINUITY.md) — branch/runtime boundaries,
   current topology, business invariants, source map, deployment flow, and
   end-of-session handoff.
2. [Architecture](ARCHITECTURE.md) — request and accounting flows, D1/R2/assets,
   caching, security, maintenance, quotas, and observability.
3. [Cloudflare operations](CLOUDFLARE_OPERATIONS.md) — production resource
   verification, snapshot migration, cutover, monitoring, and rollback.

## Verification and migration records

- [Parity matrix](CLOUDFLARE_PARITY_MATRIX.md) — route-by-route behavior and
  automated evidence.
- [Live acceptance](CLOUDFLARE_LIVE_ACCEPTANCE.md) — confirmation-gated,
  bounded production mutation suite and cleanup checks.
- [Migration plan](CLOUDFLARE_MIGRATION_PLAN.md) — historical design record.
  It explains original decisions but is not authoritative for current schema,
  code, quotas, or deployment state.

Repository-wide instructions are in [`../AGENTS.md`](../AGENTS.md), and setup
commands are in [`../README.md`](../README.md).

## Source-of-truth order

When documentation conflicts, use this order:

1. explicit current user instruction;
2. root `AGENTS.md` and applicable nested instructions;
3. current branch code, migrations, `wrangler.jsonc`, and workflows;
4. live `/healthz`, `/readyz`, Cloudflare/GitHub state for drift-prone facts;
5. current-state continuity/architecture/operations docs;
6. historical migration plan.

Never add passwords, tokens, private snapshots, business exports, or user
credentials to continuity documentation.
