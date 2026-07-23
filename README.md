# FAstockFlow

FAstockFlow is a multi-company inventory and accounting application for FirstTech
and Aditya operations. It manages masters, opening balances, purchases, sales,
stock transfers, FIFO valuation, payments, outstanding balances, reports,
exports, audit history, permissions, and private files.

The repository currently contains two independently deployed implementations:

| Track | Branch | Runtime | Data | Deployment |
| --- | --- | --- | --- | --- |
| Legacy/rollback | `main` | Flask 3, Gunicorn, Docker/VM | MySQL | `.github/workflows/deploy.yml` |
| Cloudflare production | `cloudflare/serverless-migration` | TypeScript, Hono, Cloudflare Workers | D1 + R2 + Durable Object | `.github/workflows/cloudflare-validation.yml` |

Do not merge the deployment models or deploy one track while working on the
other. Start every session with [AGENTS.md](AGENTS.md) and
[Project continuity](docs/PROJECT_CONTINUITY.md).

## Current Cloudflare production

- Worker: `fastockflow`
- URL: <https://fastockflow.stepper.workers.dev>
- D1: `fastockflow-db`, binding `DB`
- R2: private bucket `fastockflow-files`, binding `FILES`
- Durable Object: `AccountingCoordinator`, binding `ACCOUNTING`
- Schema: `0008_dashboard_read_indexes.sql`
- Scheduled maintenance: minute 17 of every hour (UTC)
- Static files: Cloudflare Worker Assets from `cloudflare/public`
- Production branch: `cloudflare/serverless-migration`

`cloudflare/wrangler.jsonc` and the production workflow are the authoritative
source for resource bindings and deployment configuration. Never put API tokens,
passwords, private exports, or production snapshots in this repository.

## Business invariants

- Negative stock is intentionally permitted.
- FIFO cost applies only to quantity covered by available FIFO layers; uncovered
  negative quantity has zero FIFO cost until later reconstruction.
- Money and quantities are persisted as scaled integers in the Worker/D1 track.
- Purchase, sale, transfer, opening, and payment edits/deletes must atomically
  rebuild or reverse their stock, FIFO, ledger, outstanding, allocation, and
  audit effects.
- Company-bound users cannot read or mutate another company. Admin/owner context
  and permission overrides must remain explicit.
- D1, cache, and query optimizations may not weaken accounting, idempotency,
  authorization, CSRF, or audit correctness.

See [Architecture](docs/ARCHITECTURE.md) and the detailed
[parity matrix](docs/CLOUDFLARE_PARITY_MATRIX.md).

## Cloudflare development

Requirements: Node.js 22+, Python 3.12+, and Wrangler.

```powershell
git switch cloudflare/serverless-migration
Set-Location cloudflare
npm ci
Copy-Item .dev.vars.example .dev.vars
npm run db:reset
npm run validate
npx wrangler dev --local
```

The local seed uses only local test credentials controlled through `.dev.vars`.
It must never be run against remote D1.

Important commands:

| Command | Purpose |
| --- | --- |
| `npm run db:reset` | Recreate local D1, replay every migration, seed fixtures |
| `npm run typecheck` | TypeScript validation |
| `npm test` | Workers-runtime Vitest suite |
| `npm run test:coverage` | Supported coverage configuration |
| `npm run test:migration` | Import, reconciliation, workflow, and migration tests |
| `npm run validate` | Full required Worker gate, including build and bundle check |
| `npx wrangler dev --local` | Local Worker |

Use the canonical `npm run test:coverage`; targeted coverage invocations can
conflict with the Workers Vitest runner.

## Flask development

Requirements: Python 3.12+ and either SQLite for local tests or MySQL for the
deployed application.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
flask init-db
flask seed-data
flask run
```

Docker:

```powershell
Copy-Item .env.example .env
docker compose up -d --build
```

Open <http://localhost:8000>. Replace every example secret and credential before
use; committed examples are not production credentials.

## Documentation map

- [Project continuity](docs/PROJECT_CONTINUITY.md): first-read handoff, current
  state, branch workflow, ownership, known boundaries, and session checklist.
- [Architecture](docs/ARCHITECTURE.md): components, request/write flows, storage,
  caching, security, and quota strategy.
- [Cloudflare operations](docs/CLOUDFLARE_OPERATIONS.md): export/import, resource
  checks, cutover, maintenance, monitoring, and rollback.
- [Live acceptance](docs/CLOUDFLARE_LIVE_ACCEPTANCE.md): bounded production
  create/edit/delete acceptance and cleanup.
- [Parity matrix](docs/CLOUDFLARE_PARITY_MATRIX.md): route and behavior coverage.
- [Migration plan](docs/CLOUDFLARE_MIGRATION_PLAN.md): historical design record;
  consult current-state documents before treating its proposals as live facts.

## Release boundaries

- A push to `main` triggers the VM deployment workflow.
- A matching code/static/workflow change pushed to
  `cloudflare/serverless-migration` validates, applies immutable D1 migrations,
  deploys the Worker, checks `/healthz` and `/readyz`, and performs authenticated
  read-only smoke checks.
- Full production mutation acceptance is manual and confirmation-gated.
- Do not perform direct remote D1/R2 mutation, DNS changes, custom-domain changes,
  production acceptance, or a branch merge without explicit authorization.
- Preserve the VM/MySQL implementation as the rollback source until retirement
  is separately approved.
