# FAstockFlow architecture

## Runtime overview

```text
Browser
  |
  | HTTPS, server-rendered HTML/JSON/files
  v
Cloudflare Worker (Hono)
  |-- Worker Assets: CSS, JS, images
  |-- D1: relational source of truth
  |-- R2: private file bytes
  |-- AccountingCoordinator Durable Object
  |     `-- serializes accounting mutation commands
  `-- hourly scheduled maintenance
```

The legacy Flask/MySQL application remains a separate deployable rollback track;
it is not in the Cloudflare request path.

## Request lifecycle

1. `requestContext` assigns request metadata, loads an authenticated user when
   cookies are present, and applies response/security policy.
2. Protected route groups require authentication.
3. Mutation-capable route groups require CSRF validation.
4. Route handlers independently enforce module permission and company scope.
5. Read handlers query D1 directly, using bounded result sets and safe reference
   caching where appropriate.
6. Accounting write handlers send commands to the global
   `AccountingCoordinator`.
7. The coordinator validates idempotency and executes the D1 accounting plan.
8. Responses are server-rendered HTML, JSON, private files, or generated export
   formats.

Hiding an action in HTML is never the authorization boundary.

## Accounting write path

Purchase, sale, transfer, opening and payment changes may affect:

- header and line rows;
- stock ledger entries;
- FIFO layers and consumptions;
- inventory balance read models;
- receivables/payables and status;
- payments and allocations;
- inter-company balances;
- audit events and alerts.

The Durable Object serializes commands so concurrent requests do not use
SQLite-style locking assumptions inherited from Flask/MySQL. D1 batches and
idempotency records provide atomicity/retry protection. Pure rules under
`src/domain` and mutation reconstruction code under `src/accounting` must remain
covered independently.

Negative stock is intentional: FIFO cost covers only quantities consumed from
available layers.

## Storage

### D1

D1 holds all relational and accounting state. Migrations are numbered,
append-only SQL files. Never edit an applied migration; add the next migration
and replay from an empty local database.

Scaled integer columns avoid JavaScript floating-point persistence errors:

- money uses paise;
- quantities use milliunits where applicable.

Indexes should correspond to demonstrated filters, joins, ordering, or open
working sets. Rows scanned and index-write cost both matter.

### R2

R2 stores private file bytes. D1 stores object metadata and lifecycle state.
Uploads are bounded, downloads are authenticated/no-store, and deletion uses
compensating state transitions. Scheduled maintenance reclaims abandoned
objects in small idempotent slices. R2 is not used for static product assets.

### Worker Assets

CSS, browser JavaScript, logos and images are built into
`cloudflare/public`. `scripts/build-static.mjs` creates the generated mapping
used by the Worker. A CI check rejects a stale committed asset manifest.

## Cache design

`src/cache/reference.ts` implements:

- 45-second default TTL;
- a bounded 64-entry module-memory L1;
- Cloudflare Cache API L2;
- company/scope-aware keys;
- explicit invalidation after relevant master mutations;
- safe D1 fallback on cache failure.

Module memory is opportunistic and may disappear at any time. It is never a
correctness dependency.

Cache-safe data currently includes companies, items, stock books and payment
modes. Accounting state, permissions, sessions, CSRF, transaction results,
balances, FIFO, reports and tenant-specific authenticated pages remain live.

KV is not currently bound because it would add quota use, eventual consistency
and invalidation complexity without solving a present requirement.

## Read budgets

- Authenticated identity/company/permission resolution: one D1 statement.
- Dashboard: one consolidated metric statement plus six other business
  statements; eight total statements including authentication.
- Lists/reports should use bounded/keyset pagination and indexed predicates.
- Never introduce per-row lookups or full growing-table reads in hot handlers.

Statement count is a regression signal, not the whole cost model. Validate rows
read, rows written, query plans, response latency and representative traffic.

## Security model

- opaque session token; only its digest is stored;
- separate CSRF token/digest;
- signed company-selection cookie;
- role permissions plus nullable per-user overrides;
- fixed-company and active-company scoping;
- login throttling and session revocation;
- authenticated private R2 reads;
- no-store policy for sensitive responses;
- safe production errors with request identifiers;
- secrets only in `.dev.vars` locally or protected GitHub/Cloudflare settings.

Imported password hashes must be compatible with Cloudflare Web Crypto limits.
Accounts whose legacy hash cannot be verified at the edge require a controlled
password reset.

## Scheduled maintenance

The hourly cron uses hard slice limits rather than unbounded deletes/scans. It
handles expired sessions/login attempts/idempotency records, abandoned R2
metadata and alternating inventory reconciliation cursors. Reconciliation raises
or resolves alerts; it does not silently overwrite accounting data.

## Observability and health

- `/healthz` reports service, environment and deployed commit.
- `/readyz` checks D1 and reports the latest applied migration.
- scheduled jobs emit structured `scheduled-maintenance` logs;
- production workflows preserve pre-deploy D1/Worker recovery evidence;
- monitoring should cover Worker errors/CPU, D1 reads/writes/storage, DO
  contention, R2 operations, auth failures, idempotency conflicts and
  reconciliation alerts.

Avoid high-cardinality or sensitive logs. Logging is also a quota.

## Deployment architecture

The Cloudflare validation workflow is the only normal production path. It runs
the same full validation gate twice (validation and deploy jobs), verifies exact
resource identity, captures recovery evidence, applies migrations and deploys
the exact commit. Concurrent production runs queue instead of cancelling during
a possible migration.

The manual live-acceptance workflow is intentionally separate because it
performs bounded production mutations before cleaning and independently checking
residue.

The Flask branch has its own VM-trigger workflow. The two triggers must remain
separate.
