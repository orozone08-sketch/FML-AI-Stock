# FAstockFlow Cloudflare Serverless Rewrite Plan

Status: implementation plan

Source baseline: `origin/main` at `7007c397053aedf9bafe0cf06b0d2308b215e8bc`

Migration branch: `cloudflare/serverless-migration`

Prepared: 2026-07-14

## 1. Outcome and non-negotiable decisions

The Flask application will be rewritten as a TypeScript Cloudflare Worker, not wrapped, transpiled, or partially proxied. The migration will preserve the existing business behavior, especially FIFO costing, intentionally permitted negative stock, payment allocation, edit/void reconstruction, company scoping, permissions, audit trails, printable documents, and report totals.

The first remote Cloudflare resources will use their final production names. There will be no disposable `preview`, `staging`, or `-dev` D1/R2 resource that later needs to be renamed or copied. Local development will use Wrangler's local emulation of those bindings. Production-named resources may be exercised first through the Worker `workers.dev` hostname, but the existing production domain and VPS will remain untouched until a separately approved cutover.

The rewrite stays isolated on `cloudflare/serverless-migration`. `main`, the current Docker/VPS deployment, and the MySQL source remain the rollback path. The branch must not be merged into `main`, attached to the live custom domain, or used to change DNS until migration verification is complete and cutover is explicitly approved.

The target architecture is:

| Concern | Target |
| --- | --- |
| HTTP application | One Cloudflare Worker using TypeScript and Hono |
| HTML | Server-rendered Hono JSX/templates, retaining the current routes and visual behavior |
| Browser behavior | Small, vendored JavaScript modules; no runtime CDN dependencies |
| Static CSS/images/scripts | Workers Static Assets with content-hashed filenames |
| Relational data | One production D1 database |
| Durable user files | One production R2 bucket; private by default |
| Accounting write serialization | One `AccountingCoordinator` Durable Object entry point for all business-document mutations |
| Sessions | Opaque, hashed, revocable sessions in D1 unless the authentication benchmark selects Cloudflare Access |
| Scheduled work | A Cron trigger only for bounded retention/reconciliation tasks that cannot run on request |
| Tests | Vitest in the Workers runtime with isolated D1/R2 bindings, plus differential parity tests against Flask |
| Deployment | GitHub Actions gated deployment from `cloudflare/serverless-migration` to the production-named Worker/resources |

Proposed final resource names:

| Resource | Final name/binding |
| --- | --- |
| Worker | `fastockflow` |
| D1 database | `fastockflow-db` / binding `DB` |
| R2 bucket | `fastockflow-files` / binding `FILES` |
| Durable Object class | `AccountingCoordinator` / binding `ACCOUNTING` |
| GitHub environment | `cloudflare-production` |
| Local secrets file | `.dev.vars` (ignored) |

Before creating anything remotely, the implementation must enumerate the intended Cloudflare account and confirm that these names are either unused or are the exact resources intended for this application. It must not silently add a suffix if a name is occupied.

## 2. Current repository assessment

The source is a server-rendered Flask 3 application with Flask-Login, Flask-WTF, Flask-SQLAlchemy, MySQL/PyMySQL, Jinja templates, ReportLab PDF generation, and OpenPyXL spreadsheet generation. SQLite is used for tests and quick local development. Docker/Gunicorn currently target an external shared MySQL network.

Inventory at the source baseline:

- 26 SQLAlchemy models.
- 81 Flask route handlers.
- 41 Jinja templates.
- 40 Python application modules.
- 12 test modules containing 92 passing tests.
- No implemented persistent upload route was found even though Docker declares an `uploads` volume.
- PDF and XLSX outputs are generated in memory; they are not durable files and should not be copied to R2 by default.
- Static logos/images are repository assets and should remain Workers Static Assets, not R2 objects.

The data model covers users and permission overrides, companies and stock books, items/suppliers/customers/payment modes, opening documents, purchases, sales, transfers, FIFO layers/consumptions, stock ledger entries, receivables/payables, payments/allocations, inter-company ledgers, audit logs, and alerts.

Critical business characteristics discovered in the code and tests:

1. Negative stock is intentional. A sale can exceed available FIFO layers. The covered quantity receives FIFO cost; the uncovered quantity has zero cost until later repair/edit logic changes the outcome. This behavior must be matched, not “fixed” during migration.
2. Editing or voiding a document can restore and re-consume FIFO layers, rebuild ledger entries, update linked receivables/payables, preserve valid payment allocations, and reject changes that would invalidate already received/paid amounts.
3. Transfers have issue/return directionality, pending-lot accounting, mismatch approval, inter-company receivable/payable entries, and ordering rules that prevent invalid reversal.
4. Company-scoped users must never see or mutate another company's data. Owner/admin users can operate across company context.
5. The current `with_for_update()` FIFO lock relies on server-database behavior that is not a safe concurrency primitive in D1/SQLite.
6. Several reports currently use unbounded `.all()` queries or aggregate complete ledgers. Those patterns would waste D1 row reads as data grows.
7. The committed `.env.example` and runtime fallback contain a real-looking default administrator password. The rewrite must remove all default production credentials and the credential should be considered exposed and rotated before cutover.
8. The current startup `create_all()` plus runtime `ALTER TABLE` mechanism must be replaced by immutable, numbered D1 migrations.

Baseline validation completed locally:

```text
92 passed
```

The warnings are dominated by naive `datetime.utcnow()` deprecation and a cyclic `company`/`user` foreign-key teardown warning in the SQLite test database. The rewrite will use explicit UTC timestamps and migration-ordered foreign keys.

## 3. Cloudflare free-tier design envelope

The architecture is designed against the Cloudflare limits published in July 2026:

- Workers Free: 100,000 requests/day, 10 ms CPU per HTTP request, 128 MB memory, 50 D1 queries per invocation, and a 3 MB Worker bundle.
- D1 Free: 5 million rows read/day, 100,000 rows written/day, 500 MB per database, 5 GB total account storage, and 7-day Time Travel.
- R2 Standard free tier: 10 GB-month storage, 1 million Class A operations/month, 10 million Class B operations/month, and free Internet egress.
- Durable Objects on Workers Free: SQLite-backed objects are available; requests and stored-row usage have free daily allowances. The accounting coordinator will not use Durable Object storage as the system of record.

Official references:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 pricing and row accounting](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 batch transaction semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

Free-tier failure is abrupt: after the daily D1 read or write allowance is exhausted, queries fail until the UTC reset. Consequently, row-read and row-write budgets are release gates, not optional observability.

## 4. Repository shape after the rewrite

The existing Flask implementation will remain intact during migration for differential tests and rollback. New code will live under `cloudflare/`:

```text
cloudflare/
  package.json
  package-lock.json
  tsconfig.json
  wrangler.jsonc
  .dev.vars.example
  migrations/
    0001_initial.sql
    0002_auth_and_idempotency.sql
    0003_read_models_and_indexes.sql
  src/
    index.ts
    app.ts
    env.ts
    auth/
    db/
    domain/
      money.ts
      quantities.ts
      fifo.ts
      payments.ts
      transfers.ts
      reconciliation.ts
    routes/
    views/
    durable-objects/
      accounting-coordinator.ts
    security/
    static/
  scripts/
    export-mysql.py
    import-d1.mjs
    verify-migration.mjs
    seed-local.mjs
  tests/
    parity/
    integration/
    performance/
  public/
```

Runtime dependencies should remain deliberately small. Hono is acceptable. Large Node compatibility packages and server-side PDF/XLSX packages must not enter the Worker bundle unless a measured bundle/CPU test proves they fit the free-tier budget.

## 5. D1 schema strategy

### 5.1 Type conversion rules

SQLite numeric affinity and JavaScript floating-point arithmetic are not acceptable sources of accounting truth. Monetary and quantity values will be stored as scaled integers:

| Domain value | D1 representation |
| --- | --- |
| Money | integer paise, scale 100 |
| Quantity | integer milli-units, scale 1,000 |
| Unit rate | integer ten-thousandths, scale 10,000 |
| GST percent | integer basis points, scale 100 |
| Boolean | integer `0`/`1` with `CHECK` |
| Date | canonical `YYYY-MM-DD` text |
| Timestamp | UTC ISO-8601 text with millisecond precision |

All multiplication, division, and rounding will use checked `bigint` helpers in TypeScript and convert to D1-safe integers only after `Number.isSafeInteger` validation. Rounding behavior will be locked to the current Python `Decimal` behavior with golden tests. No route or template may perform ad hoc currency arithmetic.

### 5.2 Core tables

The 26 source models will be represented explicitly. Existing primary IDs will be preserved during import. Foreign keys, uniqueness, status checks, and company ownership checks will be encoded in D1 wherever SQLite can enforce them.

Additional tables/read models:

- `sessions`: only SHA-256 digests of high-entropy tokens, CSRF digests, expiry/revocation, user ID, and bounded metadata.
- `login_attempts`: HMAC-digested identifiers and bounded retention for throttling/audit.
- `idempotency_keys`: user, route/action, request digest, result reference, and expiry. Duplicate POSTs return the original result rather than creating a second document.
- `inventory_balances`: one row per company/stock-book/item with current quantity, current ledger value, and a version. This avoids summing the entire stock ledger on every page.
- `data_versions`: small version counters for master/reference data and client ETags.
- `migration_manifest`: source snapshot ID, table counts, control totals, import timestamp, and verification status.
- `r2_objects`: exact private R2 key, content type, size, checksum, owner/company scope, lifecycle state, and creation metadata.

`inventory_balances` is a read model, not a replacement for the immutable stock ledger. Every accounting batch updates the ledger and its balance row atomically. A reconciliation query compares the two and raises an alert on any mismatch.

### 5.3 Index policy

Indexes reduce D1 reads but increase written rows. Only indexes proven by route/query plans will be created. Initial candidates include:

- Active FIFO lookup: `(company_id, stock_book_id, item_id, source_date, id)` with a partial predicate for available quantity.
- Stock ledger: `(company_id, stock_book_id, item_id, entry_date, id)`.
- FIFO reversal: consumptions by `(source_type, source_id, source_line_id)` and by `fifo_layer_id`.
- Sales: unique `(company_id, invoice_number)` plus company/customer/date listing indexes.
- Purchases: unique `(company_id, supplier_id, bill_number)` plus company/supplier/date listing indexes.
- Transfers: unique reference plus from-company/to-company/date indexes.
- Open receivables: company/customer/due-date/document-date partial index where balance is positive.
- Open payables: company/supplier/due-date/document-date partial index where balance is positive.
- Payments: company/customer/date and company/supplier/date.
- Sessions: unique token digest and expiry cleanup.
- Audit: created timestamp and user/entity lookup.

Every index must have an `EXPLAIN QUERY PLAN` assertion or a `rows_read` performance test. Redundant single-column indexes inherited from ORM defaults will not be copied automatically.

### 5.4 Migration discipline

- Migrations are immutable and numbered.
- Never edit an applied migration.
- Local, CI, and remote apply the same migration files.
- `PRAGMA foreign_keys = ON` is verified in tests and after import.
- Destructive migrations require a D1 Time Travel bookmark and an explicit rollback procedure.
- Runtime startup never creates or alters schema.

## 6. Correct accounting writes on D1

D1 `batch()` is transactional, but the application must often read FIFO layers before it knows which rows to update. Separate read and batch calls can race. The rewrite will use a single Durable Object instance as a low-volume accounting write coordinator:

1. All state-changing accounting routes submit a normalized command plus idempotency key to `AccountingCoordinator`.
2. The coordinator maintains an explicit promise queue so only one business-document mutation can execute its read-plan-write sequence at a time.
3. It performs indexed reads for current document state, FIFO layers, allocations, and pending transfer lots.
4. It calculates the complete mutation in deterministic domain code.
5. It sends one D1 `batch()` containing the document, lines, FIFO changes, consumption rows, stock-ledger rows, balance updates, receivable/payable/payment updates, idempotency result, and audit entry.
6. Any failed constraint or statement rolls back the entire batch.
7. A transient D1 overload error is retried with bounded exponential backoff only when the idempotency record proves retry safety.

This coordinator serializes only writes. Reads go directly from the Worker to D1. At the expected small-business volume, the single writer is an intentional correctness tradeoff. Before any later sharding, production metrics must prove it is a bottleneck; inter-company transfers make casual company-based sharding unsafe.

No essential ledger, allocation, or audit write will be placed in `waitUntil()`. The HTTP success response is returned only after the atomic D1 batch commits.

Each domain command must meet these invariants:

- A document and all of its lines either exist together or not at all.
- Stock ledger movement equals the document quantity movement.
- `inventory_balances` equals the sum of ledger movements after every commit.
- FIFO available quantity/value equals original less consumptions/restorations.
- Negative stock remains represented in the stock ledger while uncovered FIFO cost remains zero, matching the existing behavior.
- Sale/purchase paid plus balance equals total.
- Payment allocated plus unallocated equals total.
- Payment allocations equal the change in the linked receivable/payable paid amounts.
- Transfer pending lots cannot return more than the issued unreturned quantity.
- A return cannot be voided or reordered in a way that invalidates later returns.
- Audit and idempotency records commit with the business change.

## 7. D1 read and write optimization plan

### 7.1 Request-scoped loading

The existing template context can issue repeated queries for user names, company choices, permissions, and due counts. The Worker will load authentication context in one joined query and memoize it for the request. View repositories will return fully shaped rows rather than ORM-like objects that trigger hidden lookups.

Rules:

- Select only rendered/exported columns.
- Never query inside a rendering loop.
- Use one `IN (...)` lookup for related names when a join is not appropriate.
- Use keyset pagination (`date,id` or `code,id`) for growing tables; avoid deep `OFFSET` scans.
- Enforce maximum date ranges and page sizes on reports.
- Use stored totals and `inventory_balances` rather than recomputing from line/ledger history.
- Use D1 `batch()` for independent lookup queries when it reduces round trips without hiding scan cost.
- Keep active-company predicates in every repository query, not only in route code.
- Treat `SELECT *`, unbounded lists, and unindexed `LIKE '%term%'` on growing tables as release blockers.

Search will begin with normalized prefix matching over indexed code/name columns. If substring search is truly required at scale, add an explicitly measured FTS5 table and bounded synchronization; do not default every list page to full scans.

### 7.2 Caching

This is an authenticated financial application. Edge-caching complete HTML would risk cross-user and cross-company disclosure. Therefore:

- Authenticated HTML and JSON: `Cache-Control: private, no-store`.
- Login/register and other sensitive pages: `no-store`.
- Content-hashed static assets: public, one-year, immutable.
- R2 files: private; authorize company/user before streaming; support ETag, conditional requests, ranges, and `HEAD`.
- Small master lookup APIs: browser ETag revalidation using `data_versions`; no shared HTML cache.
- Permission matrices: compiled into code, not read from D1 on every action.

KV is intentionally omitted from the initial architecture. Adding a KV namespace solely because it exists would create another consistency and quota surface without solving a current workload. It can be introduced later for demonstrably safe, eventually consistent cache state.

### 7.3 Measurable budgets

Tests will capture every D1 result's `rows_read` and `rows_written` metadata. Initial acceptance budgets:

| Operation | Budget/gate |
| --- | --- |
| Session + user + company context | indexed point lookup; no scan growth with user count |
| Master/list page | returned page rows plus at most 25 supporting rows |
| Document detail | document lines/allocations plus at most 25 supporting rows |
| Dashboard | no complete ledger scan; bounded indexed aggregates/read models |
| Current stock page | `inventory_balances`, not grouped full ledger |
| Report | mandatory company/date/page bounds; test dataset scan proportional to result range |
| 10-line purchase/sale with 20 FIFO layer touches | target below 400 total rows written including indexes |
| Any normal HTTP request | fewer than 50 D1 statements on the free plan |

The 400-row write target implies at least 250 such worst-case documents/day before the 100,000-row free limit, excluding other activity. Tests will replace this estimate with measured p50/p95 row writes. If actual production volume approaches 70% of a daily limit, alert before failures and prepare the Workers Paid upgrade; correctness must never be weakened to save quota.

## 8. Authentication, authorization, and security

### 8.1 Immediate credential hygiene

- Remove the committed default admin password from runtime fallbacks and examples.
- Require bootstrap credentials through one-time secret input, then disable bootstrap.
- Rotate the existing password before the Cloudflare cutover because it is present in Git history.
- Store `SESSION_HMAC_KEY`, `CSRF_HMAC_KEY`, and any bootstrap secret through `wrangler secret`, never in `wrangler.jsonc`.
- Ensure logs, migration exports, `.dev.vars`, database dumps, and production IDs are ignored where appropriate.

### 8.2 Login decision and benchmark gate

The current Werkzeug hashes use PBKDF2-SHA256. Workers Web Crypto supports PBKDF2 and is much faster than pure JavaScript, so the first implementation will include a compatible verifier and a benchmark against a deployed Worker. It must verify existing hashes without forced password resets.

The free Worker CPU budget is only 10 ms. If representative PBKDF2 verification repeatedly exceeds that budget, do not lower the work factor to an unsafe level. Choose one of these production-safe paths:

1. Put the application behind Cloudflare Access and map the verified identity email to the D1 user/company/role record; or
2. Move to Workers Paid for a higher CPU allowance while preserving application login.

The rest of the application remains compatible with either choice through a common `AuthContext` interface. The decision is made from measured runtime behavior before production user import.

### 8.3 Session and request security

- Opaque random session and CSRF tokens; only digests stored in D1.
- Cookies: `HttpOnly`, `Secure`, `SameSite=Lax`, narrowly scoped, rotated after login/privilege change.
- CSRF on every state-changing browser request plus same-origin validation.
- Constant-time digest comparisons.
- Login throttling using HMAC-digested email/IP identifiers, bounded retention, and optional Turnstile after repeated failures.
- CSP, frame denial, MIME sniffing protection, strict referrer policy, and a narrow permissions policy.
- No secrets, raw session values, passwords, full form bodies, or private exports in logs.
- Input limits for lines per document, field sizes, date ranges, and export size.
- Company scoping and permission checks in the data-access/domain layer, even if a route forgets a UI check.
- “Last active admin” protection and permission-override parity tests.

## 9. R2 policy

The source currently has no implemented upload feature, so R2 is not on the critical path for initial accounting parity. The final production bucket will still be created with its permanent name so later file features do not repeat the Orozone naming problem.

Use R2 only for durable files such as future company logos, attachments, imported source files that must be retained, or explicitly requested archived exports. Do not store:

- bundled static assets;
- temporary PDF/XLSX output;
- database exports containing private information;
- session or application state.

Object rules:

- Immutable UUID/checksum-based keys under company-scoped namespaces.
- Private bucket; files stream through an authorized Worker route unless a narrowly scoped signed URL is required.
- Content signature and size validation before `put`.
- D1 `r2_objects` row created through a two-phase state (`pending` then `ready`) because D1 and R2 cannot commit atomically.
- Cleanup only bounded orphaned `pending` objects after a retention window.
- Deletion is soft/audited first; bulk delete requires a verified manifest.
- D1 Time Travel does not restore R2, so R2 inventory/backup is a separate recovery surface.

## 10. Route and feature migration order

### Phase 0 — Baseline, safety, and branch

- Keep the source baseline commit recorded.
- Maintain `cloudflare/serverless-migration` as the only rewrite branch.
- Keep the Python virtual environment local and ignored.
- Preserve a machine-readable inventory of models, routes, templates, tests, and current schema.
- Record all current hardcoded/default credentials and rotate them outside Git.
- Add a parity matrix mapping each of the 81 route handlers and 92 tests to its Cloudflare status.

Gate: Flask suite remains 92/92 passing and worktree contains only intentional migration files.

### Phase 1 — Cloudflare foundation

- Scaffold `cloudflare/` with pinned Node, TypeScript, Wrangler, Hono, Vitest, Workers types, formatting, and strict lint/type checks.
- Configure final production bindings in tracked `wrangler.jsonc`; local Wrangler uses local state for the same names.
- Add `/healthz` (runtime only) and `/readyz` (`SELECT 1` against D1).
- Port static CSS, JavaScript, and images with content-hashed build output.
- Add `.dev.vars.example`, secret-safe ignore rules, and local setup documentation.
- Add dry-run Worker build and bundle-size gate below 3 MB.

Gate: local Worker starts, static assets render, health/readiness pass, and CI can create an isolated D1 database.

### Phase 2 — D1 schema and deterministic seed

- Write the normalized integer-based schema and indexes.
- Port the seed data into an idempotent, local-only seed script with non-production credentials.
- Create schema constraint tests, foreign-key tests, query-plan tests, and migration replay tests.
- Build the read-only MySQL exporter and strict decimal-to-integer converter.

Gate: fresh and incrementally migrated local databases are identical; seed cannot target remote; all constraints pass.

### Phase 3 — Shared domain and security foundation

- Implement checked money/quantity/rate/GST helpers.
- Port roles, permission overrides, company context, validation, date handling, audit serialization, sessions, CSRF, login throttling, and idempotency.
- Implement and benchmark Werkzeug PBKDF2 compatibility; select application login or Access based on the CPU gate.
- Add security headers and redacted structured logs.

Gate: login/logout/session revocation/company scope/role matrix tests pass; no secret appears in bundle or logs.

### Phase 4 — Masters, users, and navigation

- Port company selection, dashboard shell, users, items, suppliers, customers, stock books, payment modes, customer APIs, search, create/edit/deactivate/delete behavior, and navigation state.
- Implement keyset pagination and request-scoped reference loaders.
- Preserve friendly duplicate validation and “deactivate if referenced” behavior.

Gate: corresponding Flask tests have Cloudflare parity tests and row-read budgets pass on large fixtures.

### Phase 5 — Accounting transaction engine

Port in small vertical slices, each behind the coordinator and one D1 batch:

1. Opening stock and opening receivable/payable/advances.
2. Purchases, payable synchronization, and purchase edits/voids.
3. Sales, FIFO consumption, receivable synchronization, and sales edits/voids.
4. Customer receipts, supplier payments, automatic allocation, edits, and deletes.
5. Inter-company issue/return transfers, pending lots, approvals, edits, and void constraints.
6. Reconciliation and alerts.

For every slice, port create, view, edit, delete/void, print/export, audit, company scope, idempotency, concurrency, and failure rollback together. Do not ship create-only transaction flows.

Gate: all transaction parity tests pass, concurrent duplicate submissions create one document, and injected statement failures leave no partial ledger state.

### Phase 6 — Dashboard, reports, calendar, and exports

- Port dashboard totals and calendar events using bounded indexed queries/read models.
- Port every report with explicit filters, keyset pagination, totals, and company scope.
- Replace server-heavy ReportLab/OpenPyXL work with print-optimized HTML and browser-side PDF/XLSX generation using vendored static libraries where possible. Worker routes provide authorized, bounded data; CPU-heavy document construction occurs in the browser.
- If a server-generated binary is a hard compatibility requirement, use a small Worker-compatible generator only after bundle and CPU benchmarks pass. Otherwise document the browser-generation contract.
- Never persist routine exports to R2.

Gate: financial control totals match Flask fixtures exactly; large report tests stay inside row/CPU limits; downloads contain no cross-company data.

### Phase 7 — Migration rehearsal

- Take a read-only, repeatable MySQL snapshot.
- Export tables in foreign-key order outside the repository.
- Convert decimals/dates strictly; reject out-of-range or ambiguous values.
- Import into a fresh local D1 database and then a disposable local test state.
- Run the full reconciliation manifest:
  - row count per table;
  - primary/foreign-key integrity;
  - user/password-hash compatibility;
  - opening, purchase, sale, payment, receivable, payable, and inter-company control totals;
  - stock quantity/value per company/book/item;
  - FIFO original/available/consumed totals;
  - allocation totals and document balances;
  - audit chronology and representative records.
- Rehearse the exact remote import against the production-named D1 only after recording its Time Travel bookmark and confirming it is the intended empty/new database.

Gate: zero unexplained reconciliation differences. Any accepted difference is written down with source rows and business approval.

### Phase 8 — Production-named resource bootstrap and workers.dev deployment

- Verify Cloudflare identity/account before every remote command.
- Create `fastockflow-db`, `fastockflow-files`, and the `fastockflow` Worker with no preview suffixes.
- Store IDs in production Wrangler configuration and secrets through Cloudflare secret management.
- Apply migrations, import the reviewed snapshot, and deploy the exact CI-validated commit to the Worker hostname.
- Do not attach the custom domain or alter DNS.
- Run authenticated acceptance tests for every module and a representative document from each data family.

Gate: health/readiness, auth, permissions, CRUD, accounting, reports, exports, row budgets, and reconciliation pass on the deployed production-named resources.

### Phase 9 — Final delta and cutover

- Announce a maintenance window and stop writes on the old app.
- Take the final MySQL snapshot/delta and a verified backup.
- Record D1 Time Travel and R2 inventory recovery points.
- Import/reconcile the delta.
- Deploy the already validated commit if necessary.
- Change only the approved Cloudflare custom-domain/DNS route.
- Verify from forced resolution and public resolvers: login, company selection, representative master data, purchase, sale, payment, transfer, reports, exports, and audit.
- Keep the old VPS/MySQL intact and read-only during the observation period.

Gate: business owner acceptance plus zero reconciliation drift after cutover smoke transactions.

### Phase 10 — Observation and retirement

- Monitor Worker errors/CPU, D1 rows read/written/storage/latency, Durable Object write queue latency, R2 operations/storage, login failures, idempotency conflicts, and reconciliation alerts.
- Alert at 50%, 70%, and 85% of daily free-tier D1/Worker limits.
- Keep rollback ready for at least the agreed observation window.
- Retire the VPS or MySQL only through a separate, explicit task after verified backups and sign-off.

## 11. Data migration procedure

The production database is not present in this clone. Git pushes move code, not live MySQL content. Migration utilities must therefore accept a separately authorized read-only MySQL connection.

Exporter requirements:

- Read-only database user with `SELECT` only.
- TLS and hostname verification by default; insecure transport requires an explicit flag for a trusted tunnel.
- Repeatable-read transaction/snapshot.
- Credentials only through environment variables or interactive secret input.
- Output outside the repository and cloud-synced directories.
- Plain inserts that fail on duplicates; no silent `REPLACE` or destructive upsert.
- Chunked statements below D1 SQL/parameter/import limits.
- Private values and password hashes treated as sensitive even though connection secrets are absent.
- A source manifest with database identity, snapshot time, table counts, and SHA-256 of export parts.

Import requirements:

- Destination account/database identity printed and confirmed by automation guardrails.
- Fresh Time Travel bookmark before remote mutation.
- Migrations before data.
- Foreign keys checked after data load.
- Explicit sequence repair for preserved numeric IDs.
- Full reconciliation before application writes are enabled.
- Export files securely removed after the migration is accepted according to the agreed retention policy.

## 12. CI/CD plan

Add a `Cloudflare validation` workflow scoped to changes on the migration branch and pull requests. Validation jobs:

1. `npm ci` with the lockfile.
2. Formatting/lint/type checks.
3. Build static assets and enforce bundle/file-size limits.
4. Apply D1 migrations to an isolated local state.
5. Run unit, integration, parity, security, migration, and row-efficiency tests.
6. Run a Wrangler dry-run bundle.
7. Scan committed files and built output for secrets/private exports.

The production deploy job:

- Runs only after validation succeeds on a push to `cloudflare/serverless-migration`.
- Uses protected GitHub environment `cloudflare-production`.
- Uses only `CLOUDFLARE_ACCOUNT_ID` and a least-privilege `CLOUDFLARE_API_TOKEN` from GitHub secrets.
- Verifies expected account and resource IDs.
- Records the current D1 Time Travel bookmark for schema/data mutations.
- Applies idempotent migrations.
- Deploys the exact tested Worker artifact.
- Runs post-deploy health/readiness and non-destructive smoke tests.
- Does not merge `main`, change DNS, attach a custom domain, or decommission the VPS.

Production D1 imports and final data deltas remain manually gated because they contain private data and need reconciliation; ordinary code deploys must never re-import or seed production data.

## 13. Test strategy and acceptance matrix

The 92 Flask tests are the minimum behavioral specification, not the complete specification. Each is mapped to one or more Worker tests. Testing layers:

- Pure domain tests for scaled arithmetic, rounding, FIFO, payment allocation, pending transfer lots, and permission matrices.
- D1 integration tests for constraints, migrations, transactional batches, indexes, and rollback.
- Route tests for status, redirects, forms, CSRF, auth, company scope, and output shapes.
- Differential tests that run the same deterministic fixtures through Flask and Worker domain implementations and compare normalized rows/control totals.
- Concurrency/idempotency tests for double-clicks, retries, simultaneous sales of the same FIFO layers, payment allocation races, and transfer return races.
- Fault-injection tests that fail each statement position in a business batch and prove no partial state.
- `rows_read`/`rows_written` regression tests with large synthetic tables.
- Security tests for session fixation, CSRF, role/company bypass, open redirects, unsafe export access, cookie flags, and log redaction.
- Migration rehearsal tests and post-import reconciliation.
- Browser smoke tests at desktop and mobile widths for navigation, transaction line editing, validation, printing, and downloads.

Release parity checklist must cover:

- Authentication and both company-specific/owner flows.
- Company selection and fixed-company restrictions.
- User and permission override administration.
- Every master CRUD/deactivation path.
- Opening stock/receivable/payable/advance create/edit/delete.
- Purchase create/edit/void/print/export.
- Sale create/edit/void/view/print/export, including negative stock.
- Transfer issue/return/edit/void/pending/mismatch approval.
- Customer receipt and supplier payment create/edit/delete/allocation.
- Customer/supplier profiles and JSON endpoints.
- Dashboard, calendar, outstanding, item/customer ledgers, and every report.
- Audit creator names and company scoping.
- 403/404/500 behavior without leaking internals.

## 14. Observability and operations

Structured logs include request ID, route name, user ID (not email), company ID, status, duration, D1 statement count, rows read/written, Durable Object queue duration, and error code. They exclude request bodies and secrets.

Operational endpoints:

- `/healthz`: Worker runtime/build identity.
- `/readyz`: D1 `SELECT 1`, schema version, and required binding presence; no private data.

Dashboards/alerts:

- Worker request/error/CPU limit failures.
- D1 daily rows read/written and database size.
- Slow/high-row queries by named operation.
- Coordinator queue time and command failures.
- Idempotency replay/conflict rate.
- Login throttling failures.
- Reconciliation mismatches.
- R2 storage/Class A/Class B if file features are activated.

Retention jobs are bounded per invocation. Session/login/idempotency cleanup uses indexed expiry and deletes a small batch, never an unbounded table delete. Reconciliation runs on a bounded company/item slice and persists a cursor if it cannot finish within the cron CPU budget.

## 15. Backup, rollback, and incident boundaries

Treat code, D1, R2, and MySQL as four independent recovery surfaces:

1. Code rollback: redeploy the last verified Worker version/commit.
2. D1 rollback: stop writes, restore to the recorded Time Travel bookmark/timestamp, then deploy schema-compatible code. Free-plan Time Travel is seven days.
3. R2 rollback: restore/re-upload from a separately verified object manifest/backup; D1 Time Travel does not restore objects.
4. Full service rollback: point the approved custom-domain route back to the preserved VPS, verify MySQL consistency, and resume writes only after confirming the chosen source of truth.

Never attempt a D1 restore while Worker writes continue. Never assume rolling back code reverses schema or data. Never bulk-delete R2 objects without a manifest proving scope. During any consistency incident, freeze writes first and preserve request IDs, timestamps, deployment versions, D1 bookmarks, and reconciliation output.

## 16. Known risks and explicit mitigations

| Risk | Mitigation |
| --- | --- |
| D1 read exhaustion from report scans | Keyset pagination, mandatory ranges, covering/partial indexes, read models, rows-read tests |
| D1 write exhaustion from ledger/index amplification | Minimal indexes, measured per-command writes, alerts, paid-plan threshold rather than weakening accounting |
| FIFO race during read-plan-write | Single accounting Durable Object queue plus one D1 batch and idempotency |
| Partial accounting update | All document/ledger/allocation/audit changes in one D1 batch; fault-injection tests |
| JS floating-point drift | Scaled integers and checked `bigint` arithmetic with Flask golden tests |
| Password verification exceeds free CPU | Web Crypto benchmark; Cloudflare Access or Workers Paid, never unsafe hash weakening |
| ReportLab/OpenPyXL incompatibility/CPU | Browser-side generation from authorized bounded data; static libraries outside Worker bundle |
| Authenticated data cached publicly | `private, no-store`; only hashed static assets receive immutable public caching |
| D1/R2 non-atomic files | Pending/ready object state, checksum, idempotent reconciliation, bounded orphan cleanup |
| Production resource naming drift | Create final names first, verify account/resource identity, no automatic suffix fallback |
| Silent migration corruption | Strict decimal conversion, preserved IDs, manifest, full control-total reconciliation |
| Free tier becomes insufficient | Alert at 50/70/85%; document a paid-plan switch before limits cause outages |

## 17. Definition of done

The rewrite is complete only when all of the following are true:

- Every route/feature has a parity disposition and no unapproved functional omission remains.
- All 92 existing behaviors are represented in the Worker tests and pass.
- D1 schema constraints, migration replay, foreign keys, and reconciliation pass.
- Concurrency, duplicate-submit, and injected-failure tests prove atomic accounting behavior.
- Read/write budgets pass on synthetic scale fixtures.
- Worker bundle, CPU, request, and D1 statement counts fit the chosen Cloudflare plan.
- Existing user hashes authenticate or an approved Access migration is complete.
- No default credential, secret, dump, or private export exists in Git/build logs.
- Production-named D1/R2/Worker bindings are verified against the intended Cloudflare account.
- The production data snapshot and final delta reconcile with zero unexplained differences.
- Deployed workers.dev acceptance tests pass before DNS changes.
- Cutover and rollback commands are documented and rehearsed.
- The VPS/MySQL rollback remains intact until a separate retirement approval.

## 18. Immediate next implementation slice

After approval of this plan, implementation should begin without another architecture round:

1. Create the `cloudflare/` TypeScript/Worker/Vitest scaffold.
2. Add final-name Wrangler bindings using placeholders until the intended Cloudflare account is verified.
3. Create health/readiness, static asset build, local D1 migrations, and deterministic local seed.
4. Port money/quantity arithmetic and authentication/company/permission foundations.
5. Establish the parity matrix and rows-read/write test harness before porting transaction routes.

The first remote mutation is resource identity verification and creation of the final production-named resources. It does not include DNS or custom-domain cutover.
