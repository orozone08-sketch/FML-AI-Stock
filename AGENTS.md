# FAstockFlow Repository Guidance

These instructions apply to the entire repository. More specific `AGENTS.md`
files may add stricter rules for their subdirectories.

## Deployment boundaries

- `main` is the legacy Flask/VM application.
- `cloudflare/serverless-migration` is the Cloudflare production branch.
- Never deploy the Flask application when changing the Cloudflare branch, and
  never deploy the Worker from `main`.
- Production Cloudflare changes must flow through the validation/deployment
  workflow for `cloudflare/serverless-migration`. Do not bypass it with an
  ad-hoc local production deploy.
- Treat D1, R2, KV, Durable Objects, Queues, DNS, secrets, and custom domains as
  production resources. Confirm the intended environment and resource identity
  before mutating them.

## Cloudflare free-tier and quota discipline

- Design for the applicable Cloudflare free-plan limits. Before introducing or
  materially changing a Cloudflare product, verify its current official limits;
  do not rely on remembered numeric quotas.
- Prefer the fewest Cloudflare products that meet the requirement. Do not add KV,
  Durable Objects, Queues, R2, or another service when D1 plus the Cache API (or
  static Worker Assets) is sufficient.
- Estimate request, CPU, subrequest, D1 row-read/row-write, storage, R2 operation,
  KV operation, Durable Object, log, and egress impact for new hot paths.
- Avoid unbounded fan-out, per-row queries, write amplification, polling, large
  scans, and scheduled work that repeatedly touches unchanged data.
- Keep cron jobs infrequent, incremental, idempotent, and bounded. Record a
  cursor or generation when that prevents rescanning.
- Do not use a paid feature or assume a paid limit without explicit approval.

## D1 rules

- Minimize both statement count and rows scanned. Prefer set-based queries,
  joins, aggregates, `IN` batches, and `DB.batch()` over N+1 reads.
- Add and test selective indexes for recurring filters, joins, and ordering.
  Use partial indexes for active/open working sets when appropriate, while
  accounting for their write and storage cost.
- Select only required columns and bound result sizes. Paginate large lists and
  reports; never load an entire growing table into Worker memory.
- Cache only data whose staleness is acceptable. Never cache balances, FIFO
  state, permissions, CSRF/session validation, transaction results, or other
  correctness-critical accounting state.
- Reference-data caches must be tenant/scoped, short-lived, bounded, and
  invalidated by every relevant mutation. Cache failures must fall back safely
  to D1.
- Keep schema migrations immutable and append-only. Test a full migration replay
  from an empty local D1 database before pushing.
- Preserve transaction, idempotency, tenant-isolation, and audit invariants.
  A read reduction is invalid if it weakens any of them.

## KV, Cache API, R2, and Worker Assets

- Use Worker Assets for versioned static files.
- Use the Cache API for short-lived, recomputable, non-sensitive responses or
  reference data when colo-local caching is acceptable.
- Add KV only for read-heavy, globally distributed, eventually consistent data
  that needs persistence beyond an isolate/cache eviction. Document its key
  namespace, TTL, invalidation, consistency expectations, and operation budget.
- Never use KV as the source of truth for inventory, money, permissions,
  sessions, locks, or transactional state.
- Store blobs and large exports in R2, not D1 or KV. Keep metadata in D1, use
  deterministic object keys, clean up abandoned objects, and avoid unnecessary
  list/class-A operations.
- Set explicit cache headers and never publicly cache authenticated HTML or
  user/tenant-specific responses without a proven private cache design.

## Worker runtime practices

- Keep request handlers stateless and safe under concurrent execution. Do not
  rely on module memory for correctness; it may only be an optional bounded L1.
- Bound request bodies, loops, batches, retries, generated exports, and in-memory
  collections. Stream large payloads where supported.
- Avoid Node-only APIs unless Workers compatibility and bundle impact are tested.
- Keep secrets out of source, logs, artifacts, SQL snapshots, and client code.
- Preserve security headers, CSRF protection, signed cookies, tenant checks,
  authorization checks, and no-store behavior for sensitive responses.
- Emit useful but non-sensitive observability. Sample or aggregate noisy events
  so logging quotas are not consumed by normal traffic.

## Required validation for Cloudflare changes

- Run from `cloudflare/`:
  - `npm run db:reset` for schema or migration changes.
  - `npm run validate` for every Worker change.
- Add regression tests for query-count reductions, cache scoping/invalidation,
  tenant boundaries, and migrations when those areas change.
- Review `git diff --check`, the complete scoped diff, generated assets, bundle
  size, and a secret scan before committing.
- Push only the intended Cloudflare branch, monitor its workflow to completion,
  and verify live `/healthz` reports the exact commit and `/readyz` reports the
  expected schema.
- Do not claim a quota improvement from statement count alone. Where practical,
  compare D1 query/row metrics before and after representative traffic.
