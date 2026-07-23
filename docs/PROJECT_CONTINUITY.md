# FAstockFlow project continuity

This is the first operational handoff document for a new human or agent session.
Read it together with the root `AGENTS.md`. Facts that can drift are deliberately
linked to their authoritative file instead of duplicated.

## Session orientation

1. Locate the checkout and run `git status --short`, `git branch --show-current`,
   `git remote -v`, and `git log -5 --oneline`.
2. Read `AGENTS.md`, this file, and the runbook relevant to the requested track.
3. Confirm whether the task targets legacy Flask/VM (`main`) or Cloudflare
   (`cloudflare/serverless-migration`).
4. Preserve unrelated changes. Use a clean worktree when the intended branch is
   checked out elsewhere or the current checkout is dirty.
5. Inspect the live workflow/configuration before relying on a previous commit,
   schema number, quota, deployment result, or credential setup.

## Repository and ownership boundaries

- Repository: `orozone08-sketch/FML-AI-Stock`
- Legacy branch: `main`
- Cloudflare production branch: `cloudflare/serverless-migration`
- Cloudflare code root: `cloudflare/`
- Legacy application root: `app/`
- Legacy tests: `tests/`
- Cloudflare tests: `cloudflare/tests/`
- Shared product assets originate in `app/static/`; the Worker asset build writes
  its deployable manifest/assets under `cloudflare/`.

The branches are not deployment environments for one application binary. They
are separate runtime implementations with separate production triggers.

## Product scope

FAstockFlow is a server-rendered, multi-company stock and accounting system. Its
required product surface includes:

- authentication, password change, registration, sessions, CSRF, company
  selection, roles, and per-module permission overrides;
- companies, stock books, items, customers, suppliers, users, and payment modes;
- opening stock, pending stock, opening receivables/payables/advances;
- purchases, sales, transfers, FIFO layers/consumption, stock ledger and
  materialized inventory balances;
- customer receipts, supplier payments, allocation, receivable/payable status,
  outstanding details, and inter-company balances;
- dashboards, calendar events, stock/FIFO/ledger/sales/purchase/payment/audit
  reports, printable views, CSV/XLSX/PDF exports;
- audit logs, critical reconciliation alerts, and private R2 files.

There is no required chatbot, OCR, WebSocket collaboration, push notification,
Workers AI, or Vectorize feature. Do not create those resources as assumed
parity work.

## Non-negotiable domain behavior

- Negative inventory is valid behavior.
- FIFO consumes available layers deterministically. Uncovered negative quantity
  carries zero cost rather than inventing a future cost.
- Persisted money and quantity values on D1 use scaled integers, not floating
  point.
- Business-document mutations are atomic and idempotent.
- Editing or voiding documents reconstructs all dependent accounting state.
- Allocated receivables/payables cannot be changed below paid/received amounts.
- Transfer direction, pending lots, mismatch approval, and inter-company entries
  must remain consistent.
- Company isolation and authorization are enforced in data access and mutation
  logic, not only by hiding UI controls.
- Audit records are part of the mutation, not a best-effort side effect.

The legacy services and tests remain the behavioral oracle where a parity detail
is unclear. See `docs/CLOUDFLARE_PARITY_MATRIX.md`.

## Current Cloudflare topology

| Component | Production identity | Purpose |
| --- | --- | --- |
| Worker | `fastockflow` | Hono HTTP app and scheduled handler |
| URL | `https://fastockflow.stepper.workers.dev` | Current production hostname |
| D1 | `fastockflow-db` / `DB` | Relational source of truth |
| R2 | `fastockflow-files` / `FILES` | Private durable objects/files |
| Durable Object | `AccountingCoordinator` / `ACCOUNTING` | Serializes accounting commands |
| Assets | Worker Assets / `ASSETS` | Versioned CSS, JS, images |
| Cron | `17 * * * *` | Bounded cleanup and reconciliation |
| Schema | `0008_dashboard_read_indexes.sql` | Current documented schema |

Authoritative configuration: `cloudflare/wrangler.jsonc`.

The Durable Object is a coordination boundary, not the accounting database. D1
remains the source of truth. R2 is private and D1 stores its metadata/lifecycle.

## Cloudflare source map

| Location | Responsibility |
| --- | --- |
| `cloudflare/src/index.ts` | Worker fetch/scheduled entry and DO export |
| `cloudflare/src/app.ts` | Hono app, middleware, routes, health/readiness |
| `cloudflare/src/middleware.ts` | request context, auth/CSRF and response policy |
| `cloudflare/src/auth/` | session loading and signed company context |
| `cloudflare/src/security/` | crypto and permission matrix |
| `cloudflare/src/routes/` | server-rendered and JSON HTTP endpoints |
| `cloudflare/src/accounting/` | command validation and accounting mutations |
| `cloudflare/src/durable-objects/` | serialized mutation entry point |
| `cloudflare/src/domain/` | pure scalar/FIFO/payment/transfer invariants |
| `cloudflare/src/reports/` | report repository, filtering and exports |
| `cloudflare/src/cache/` | safe reference-data cache |
| `cloudflare/src/maintenance.ts` | bounded scheduled cleanup/reconciliation |
| `cloudflare/migrations/` | immutable, ordered D1 schema history |
| `cloudflare/scripts/` | local DB, migration, reconciliation and acceptance tools |
| `cloudflare/tests/` | Worker, domain, security, migration and parity tests |

## Data and cache strategy

- D1 is authoritative for sessions, permissions, masters, accounting documents,
  FIFO, ledger, balances, allocations, audit, alerts, and R2 metadata.
- Authentication loads session, user, active company, and permission overrides
  in one D1 statement.
- The dashboard uses one consolidated metric statement and seven business
  statements in total; with authentication the expected request budget is eight
  D1 statements.
- Companies, items, stock books, and payment modes may use a bounded 64-entry
  per-isolate L1 plus Cloudflare Cache API L2 for 45 seconds.
- Cache keys are scoped; mutations invalidate relevant L1/L2 entries.
- Balances, FIFO, permissions, sessions/CSRF, transaction results, financial
  reports, and authenticated HTML are not reference-cache candidates.
- KV is intentionally not used. Add it only when its distributed persistence and
  eventual consistency are specifically required and operation/invalidation
  budgets have been reviewed.
- D1 migrations `0007` and `0008` add reviewed access paths and partial indexes;
  avoid speculative or overlapping indexes because they increase write/storage
  cost.

Quota rules live in `AGENTS.md`. Verify current official Cloudflare limits before
making numeric capacity claims.

## Authentication and secrets

- Worker sessions are opaque, hashed, revocable D1 records.
- Session/company cookies are signed and CSRF protection is required for
  mutations.
- Local Worker secrets belong in ignored `cloudflare/.dev.vars`.
- Production Cloudflare values belong in the protected GitHub environment and
  repository Actions secrets listed in `docs/CLOUDFLARE_OPERATIONS.md`.
- VM credentials belong only in GitHub secrets/server configuration.
- Never copy secrets from chat history into source or documentation.
- Never expose production user passwords. Use a dedicated least-privilege smoke
  user stored in GitHub Actions secrets.
- Treat any committed example credential as an example requiring replacement,
  never as a valid production login.

## Local and CI validation

Cloudflare:

```powershell
Set-Location cloudflare
npm ci
npm run db:reset
npm run validate
```

`npm run validate` builds static assets, typechecks, runs Workers tests and the
supported coverage configuration, runs Python/Node migration checks, performs a
Wrangler dry-run build, and enforces the bundle budget.

Flask:

```powershell
py -m pytest
```

For UI or interaction changes, also test the actual browser flow and verify that
frontend asset/API wiring works. A green unit suite alone is not visual parity.

## Deployment and production verification

Cloudflare code changes are pushed only to `cloudflare/serverless-migration`.
The validation workflow:

1. installs locked dependencies;
2. replays migrations and deterministic seed;
3. runs the full validation gate and secret scan;
4. verifies the exact resource identity;
5. records the pre-deploy D1 bookmark and Worker version as a recovery artifact;
6. applies immutable remote D1 migrations;
7. deploys the exact tested commit;
8. waits for `/healthz` to report that commit;
9. verifies `/readyz` and authenticated dashboard/report/R2 reads.

The manual live-acceptance workflow creates, edits, and cleans bounded production
fixtures. Run it only with explicit authorization and its exact confirmation
input.

Flask/VM changes are pushed to `main`, whose separate workflow triggers the
server deployment. Never push Cloudflare work to `main` to obtain a deploy.

## Data migration and cutover

- MySQL export uses `cloudflare/scripts/export-mysql.py` with a read-only source
  account and a repeatable-read consistent snapshot.
- Snapshot parts contain sensitive business data and password hashes. Keep them
  encrypted, outside the repo and sync folders.
- Import and verification are explicit, manifest-based, and confirmation-gated.
- Reconciliation covers table counts, control totals, foreign keys, stock ledger
  versus inventory balances, and sensitive accounting aggregates.
- Never seed production D1, silently upsert a partial import, or accept an
  unexplained reconciliation difference.
- Only one database may accept production writes during cutover.
- D1 Time Travel does not restore R2. Recovery needs separate R2 inventory/backup.
- Keep the VM/MySQL source intact and read-only until retirement is explicitly
  approved.

See `docs/CLOUDFLARE_OPERATIONS.md` for exact commands and rollback sequencing.

## Known historical milestones

- The Cloudflare branch originated from the Flask production baseline at
  `7007c397053aedf9bafe0cf06b0d2308b215e8bc`.
- D1/cache optimization was deployed in `f102909f5eae687947a33e3a760e6bf0173dd4a8`.
- That optimization reduced dashboard requests from about 15–16 D1 statements to
  eight, introduced safe reference caching, and added schema `0008`.

These hashes are audit landmarks, not an instruction to reset or redeploy them.
Always inspect current HEAD and live health before acting.

## End-of-session handoff

Before declaring work complete:

- show the exact branch, commit, and worktree status;
- report tests actually run and any unverified area;
- distinguish local completion from push, deployment, and live verification;
- link the workflow run for a production deploy;
- confirm `/healthz` commit and `/readyz` schema after Cloudflare deployment;
- record any remote mutation, migration, recovery artifact, or cleanup residue;
- identify documentation that became stale and update it in the same change;
- never store transient credentials or private data as continuity notes.
