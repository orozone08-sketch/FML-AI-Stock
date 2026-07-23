# FAstockFlow Cloudflare operations

Current-state orientation is maintained in `PROJECT_CONTINUITY.md` and
`ARCHITECTURE.md`. This file is the detailed production runbook. Verify current
HEAD, `cloudflare/wrangler.jsonc`, the latest migration, and live health before
executing any remote command.

This runbook applies only to `cloudflare/serverless-migration`. The permanent production names are Worker `fastockflow`, D1 `fastockflow-db`, and private R2 bucket `fastockflow-files`. Never create suffixed preview resources. Never attach the custom domain or alter DNS during rehearsal.

## Local setup and validation

Use Node 22+, Python 3.12+, and a copied `cloudflare/.dev.vars.example` named `.dev.vars`. From `cloudflare/`:

```powershell
npm ci
node scripts/reset-local.mjs --empty
npm run validate
npx wrangler dev --local
```

The local seed is deterministic, contains only an `@local.invalid` account, forces a password change, and refuses `--remote`. Delete `.wrangler/state` and rerun `npm run db:reset` to prove migrations replay from zero.

Schema `0007` adds reviewed serverless access paths rather than broad index permutations: party-first sale/receivable/payment and purchase/payable/payment indexes for all-company profiles, plus parent-key indexes for opening, purchase, sale, and transfer lines. Existing company-first indexes handle fixed-company logins. The partial party indexes avoid write amplification on the opposite payment party, while the four child indexes trade one small index write for eliminating growing scans in profile, print, edit, void, and delete paths. Schema `0008` adds partial all-company dashboard indexes for active sales/purchases and open receivable/payable/inter-company working sets. Do not add overlapping permutations without confirming the deployed query plan and write cost.

Production self-registration matches the legacy public company-user flow and is protected by a signed unauthenticated CSRF cookie/token pair plus login-rate controls. Cloudflare Web Crypto accepts at most 100,000 PBKDF2 iterations; imported Werkzeug password hashes with a higher iteration count must be marked for a controlled password reset before cutover because they cannot be verified at the edge.

## Snapshot export

Create a MySQL user with `SELECT` only. Do not use an application or administrative credential. Export files contain private business data and password hashes; place them on an encrypted local volume outside this repository and outside OneDrive/Dropbox/Google Drive/iCloud.

```powershell
$env:MYSQL_HOST='db.internal'
$env:MYSQL_PORT='3306'
$env:MYSQL_DATABASE='fastockflow'
$env:MYSQL_USER='fastockflow_export_ro'
$env:MYSQL_PASSWORD='<interactive-secret>'
python scripts/export-mysql.py --output D:\secure-migrations\fastockflow-20260714
Remove-Item Env:MYSQL_PASSWORD
```

TLS hostname verification is the default. `--allow-insecure-transport` is only acceptable through a separately authenticated trusted tunnel. The exporter starts a repeatable-read, read-only consistent snapshot, preserves IDs, rejects lossy scaled decimals or unsafe integers, creates duplicate-failing plain INSERTs, chunks output, and hashes every part. It never commits or writes to MySQL.

## Local rehearsal

```powershell
npm run db:reset
node scripts/import-d1.mjs D:\secure-migrations\fastockflow-20260714
node scripts/verify-migration.mjs D:\secure-migrations\fastockflow-20260714
```

Verification compares all 26 source-model table counts, scaled money/quantity control totals, and foreign-key integrity. A nonzero exit or any unexplained difference stops migration. Representative login, company scope, opening, purchase, sale including negative stock, payment allocation, transfer, report, and audit tests must then pass.

After every completed snapshot import, the importer rebuilds `inventory_balances` from the complete stock ledger. This is mandatory because the source application calculates current stock from ledger history and has no equivalent materialized table to export. Verify that every distinct ledger company/book/item key has a balance row and that its quantity and signed value match the ledger aggregate before cutover.

## Production resource bootstrap

Before any remote mutation, run `npx wrangler whoami`, verify the intended account, and confirm the three permanent names are unused or exactly the intended resources. Replace the all-zero D1 ID only through the protected deployment workflow/secret. Do not commit an account ID, API token, or private export.

Required GitHub repository Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` with least privilege for this Worker, D1, R2 and Durable Object deployment
- `FASTOCKFLOW_D1_DATABASE_ID`
- `FASTOCKFLOW_WORKER_URL`
- `FASTOCKFLOW_SMOKE_LOGIN_ID`, `FASTOCKFLOW_SMOKE_PASSWORD`, and `FASTOCKFLOW_SMOKE_COMPANY_ID` for a dedicated active, company-bound production smoke user with `reports:view`. The deploy workflow logs in, reads the dashboard and current-stock report, verifies R2 availability without modifying business data, and revokes its session.

The workflow verifies the exact tested commit, configured D1 UUID, remote D1 UUID, Worker name, and R2 bucket name before any production mutation. It captures the pre-deploy D1 Time Travel bookmark and current Worker version, then uploads a private `fastockflow-recovery-<run-id>` Actions artifact before applying migrations. That artifact contains the raw evidence and an exact `RECOVERY.md` command sheet. Download and retain it for the observation window. It does not import production data or change DNS.

Only the seven Cloudflare secrets listed above are passed into the reusable production workflow. Do not use `secrets: inherit`: the repository also contains VM deployment credentials that must never be visible to the Cloudflare job. Production runs queue rather than cancel one another because cancellation during a D1 migration is not a safe rollback mechanism. A change under `app/static/**` is a production change and triggers the same validation/deployment path as Worker source.

## Remote import rehearsal

Freeze application writes before a final snapshot/delta. Record the source snapshot time, old-app maintenance start, Git commit, Worker version, D1 bookmark, and an R2 inventory. Confirm the destination is the intended empty/new `fastockflow-db`.

```powershell
$env:EXPECTED_CLOUDFLARE_ACCOUNT_ID='<account-id>'
$env:CLOUDFLARE_ACCOUNT_ID='<same-account-id>'
$env:EXPECTED_D1_DATABASE_ID='<verified-database-uuid>'
$env:EXPECTED_D1_DATABASE_NAME='fastockflow-db'
node scripts/import-d1.mjs D:\secure-migrations\fastockflow-final --remote --confirm-production-import
node scripts/verify-migration.mjs D:\secure-migrations\fastockflow-final --remote --confirm-production-read
```

Do not seed remote D1. Do not use `REPLACE`, silent upserts, or rerun a partially accepted import. On failure, keep writes frozen, preserve logs/request IDs, restore to the pre-import bookmark, and repeat against a clean destination only after diagnosis.

## Cutover and observation

Cutover requires zero unexplained reconciliation differences and explicit business approval. Import the final delta while old writes remain frozen, re-run reconciliation and authenticated acceptance, then change only the approved route/DNS. Keep VPS/MySQL intact and read-only. Monitor Worker errors/CPU, D1 rows read/written/storage, coordinator queue latency, idempotency conflicts, login failures, reconciliation alerts, and R2 operations. Alert at 50%, 70%, and 85% of free-tier daily limits.

## Scheduled maintenance

The production Worker runs `17 * * * *` (minute 17 of every hour, UTC). Each invocation has hard application-level limits: at most 100 expired sessions, 100 login attempts older than 30 days, 100 expired idempotency keys, 20 abandoned R2 records, and 20 reconciliation keys. Repeated hourly runs drain backlogs without a full-table delete or an unbounded ledger aggregation.

R2 records left in `PENDING` or `ORPHANED` for more than 24 hours are reclaimed in bounded slices. Before touching R2, maintenance conditionally changes a stale `PENDING` row to `ORPHANED`; if the row became `READY` after the query, the conditional claim changes zero rows and R2 is not touched. Once claimed, the idempotent R2 delete runs before the conditional `ORPHANED` metadata delete. A failed R2 or D1 operation leaves retryable `ORPHANED` metadata for the next run. `READY` and `SOFT_DELETED` records are never handled by this orphan job. At the maximum slice, claiming and deleting consumes at most 40 D1 row writes per hourly invocation.

User deletion follows a separate compensated sequence: D1 conditionally transitions `READY` to `SOFT_DELETED`, then R2 bytes are deleted. If R2 rejects the delete, D1 is conditionally restored to `READY` so the still-present object remains reachable. Downloads are private/no-store, support `HEAD`, one RFC-style byte range, ETag revalidation, and never make the bucket public. Uploads remain capped at 10 MiB and require `Content-Length`; do not raise that limit without re-evaluating Worker memory and CPU limits.

Inventory reconciliation alternates between two persisted cursor phases. The balance phase detects stale read-model rows, including balances whose ledger is now empty. The ledger phase detects ledger keys with a missing `inventory_balances` row. Each key uses the indexed `(company_id, stock_book_id, item_id, entry_date, id)` ledger path. Differences create one unresolved `INVENTORY_RECONCILIATION` critical alert per company/book/item; matching data resolves an existing alert. The job reports counts only and never repairs accounting values automatically.

Check recent cron results in Workers observability for the structured `scheduled-maintenance` event. Investigate any non-zero `reconciliation.mismatches`; repair through an approved accounting correction or restore procedure, never by manually overwriting the read model without reconciling the underlying ledger. If a backlog persists, keep the hourly limit and allow later invocations to drain it rather than increasing limits during peak traffic.

## Rollback boundaries

Every deployment run uploads `fastockflow-recovery-<run-id>` before the first mutation. Start with its `RECOVERY.md`, not a newly queried bookmark: a bookmark captured after the incident is not the pre-migration recovery point. The artifact also names the exact Worker version receiving traffic before the candidate deployment. GitHub artifact retention is 30 days, while D1 Time Travel availability is controlled by Cloudflare and may be shorter; recover promptly.

1. Freeze Worker writes first. Record incident time, request IDs, deployment version and current D1 bookmark.
2. Code rollback: redeploy the last schema-compatible verified Worker commit.
3. D1 rollback: with writes stopped, restore the recorded Time Travel bookmark, then deploy matching code. Code rollback alone does not reverse data/schema.
4. R2 rollback: restore from the independently verified object inventory/backup. D1 Time Travel never restores R2.
5. Full service rollback: route the approved domain back to the preserved VPS, verify MySQL is the chosen consistent source, then resume writes there only.

Never restore D1 while writes continue, bulk-delete R2 without a reviewed manifest, or allow both MySQL and D1 to accept production writes. VPS/MySQL retirement is a separate explicitly approved task after the observation window and verified backups.

After acceptance, securely erase snapshot parts according to the agreed retention policy and retain only non-sensitive reconciliation evidence, snapshot IDs, hashes, bookmarks, and approval records.
