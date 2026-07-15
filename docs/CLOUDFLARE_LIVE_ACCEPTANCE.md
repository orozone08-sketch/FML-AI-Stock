# Cloudflare production acceptance

The `Cloudflare production acceptance` GitHub Actions workflow is a manual, production-only verification for the permanent `cloudflare/serverless-migration` branch. It does not deploy code, invoke the VM workflow, seed D1, or run on a push or pull request.

## Run it

1. Deploy and verify the intended `cloudflare/serverless-migration` commit first.
2. In GitHub Actions, select **Cloudflare production acceptance** on that branch.
3. Enter `RUN_PRODUCTION_ACCEPTANCE` in the confirmation field.
4. Review the job summary and the seven-day evidence artifact. A passing run must also pass the independent remote D1/R2 residue query.

The job uses the existing protected Cloudflare and `FASTOCKFLOW_SMOKE_*` secrets. The smoke user must remain bound to `FASTOCKFLOW_SMOKE_COMPANY_ID`. For full mutation coverage it needs create/edit/deactivate authority for opening entries, purchases, sales, transfers, and payments; a non-viewer account can exercise its own R2 upload/delete path. Before creating a business record, the script probes nonexistent ID `0` to prove the account can also edit and clean up that record. A module with incomplete lifecycle authority is skipped before any write. A `VIEWER` account still verifies login, session/public CSRF, dashboard access, R2 readiness, and all accessible read pages, but the result explicitly lists the mutation groups it could not run and the workflow fails instead of presenting partial coverage as a production pass.

## Safety and free-tier budget

Each run uses a random `QA-...` reference prefix and fixed idempotency keys. It selects existing active masters instead of creating them, uses one small line per document, uploads one tiny R2 object, and resolves at most one destination stock book. The bounded happy path creates one opening stock, purchase, sale, transfer, payment, and file. It edits each accounting document once, validates R2 with HEAD/range/full reads, and then cleans up in reverse dependency order.

Accounting voids intentionally retain their audit history and idempotency records. These are not active residue. The workflow fails if it finds an active QA opening, purchase, sale, transfer, payment, or non-deleted R2 object after cleanup. It also fails if an HTTP list still exposes the QA prefix.

Do not run the workflow during a real user write window. GitHub serializes it with Cloudflare deployments, but it cannot lock users out of the application. If a run fails, keep the evidence artifact, search production by the exact QA prefix shown in the summary, and finish cleanup before retrying.
