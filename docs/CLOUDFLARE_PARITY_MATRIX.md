# Cloudflare migration parity matrix

This is the acceptance contract for rewriting the Flask application as a Cloudflare-native application. It is deliberately source-derived: 81 Flask route decorators, 41 Jinja templates, 26 SQLAlchemy model classes, 15 service modules, and all 92 pytest cases were inventoried. A route is not considered complete merely because it returns `200`; its authorization, active-company scope, validation, accounting side effects, FIFO behavior, audit entry, export/print output, and error behavior must match.

The machine-readable companion is `cloudflare/tests/parity/legacy-contract.json`. Status starts as **NA** (`not-assessed`) so implementation owners must earn **I** (implemented) and then **T** (tested). **O** means an intentional omission approved in this document; **B** means blocked.

## Cross-cutting contract

- Authentication uses a server-side-verifiable session, rejects inactive users, preserves the safe local `next` destination, and supports normal, company-specific, and separate administrator login. Password hashes must be migrated without silently downgrading security.
- Every mutation is CSRF protected. All user-supplied path, form, and query identifiers are validated; unsafe external `next` URLs remain forbidden.
- The global company gate applies after authentication. Fixed-company users cannot escape their company. Multi-company users may select a company or an authorized all-company view. Every document lookup and mutation independently verifies company scope; hiding UI is not authorization.
- Permissions retain the current role matrix plus nullable per-user overrides. Routes marked `dynamic` choose the module/action from the master kind or operation. Edit/delete handlers often check permissions inside the handler and must not lose those checks in the rewrite.
- Monetary and quantity calculations retain exact decimal semantics. D1 stores scaled integers, uses atomic batches/transactions for accounting writes, and never uses JavaScript floating point for persisted totals. Dates remain ISO calendar dates rather than timezone-shifted instants.
- Mutations preserve audit logging and rollback as one unit. Purchase/sale/transfer/opening/payment edits and deletes must reverse and rebuild dependent stock ledger, FIFO layers, allocations, receivables/payables, and balances exactly as the Flask services do.
- HTML routes preserve the corresponding screen, flash/error feedback, filtering, navigation, company theme/logo, due-alert badge, and authorization-aware actions. JSON API routes preserve their response shapes. CSV/PDF/print routes preserve content disposition, content type, totals, and company-scoped data.
- `403`, `404`, and safe `500` responses remain distinct. Production responses must not leak SQL, bindings, secrets, stack traces, or R2 object keys.

## Route-by-route matrix

Access abbreviations: `public`, `login`, `module:action`, and `dynamic`. Scope is `none`, `select` (company-selection flow), `active/all`, or `document` (active/all plus explicit document ownership verification).

### Authentication and company context (9)

| Route | Access / scope | Required behavior | Existing tests | Status |
|---|---|---|---|---|
| `GET /` | public / none | Redirect authenticated users to dashboard and others to login. | navigation | NA |
| `GET,POST /login` | public / none | Render company-aware login; validate active user/password, set permitted company context, safe redirect, audit success/failure. | navigation | NA |
| `GET,POST /login/company/:company_id` | public / none | Validate company target and delegate to the same login contract with company fixed. | navigation | NA |
| `GET,POST /register` | public / none | Render/validate registration, prevent duplicate login ID, hash password, assign safe defaults, audit. | navigation | NA |
| `GET,POST /admin/login` | public / none | Separate admin-only login; non-admin credentials must not create a session. | navigation | NA |
| `POST /logout` | login / none | CSRF-protected audit, clear session and company context, redirect. | navigation | NA |
| `GET /company/choose` | login / select | List only allowed active companies; fixed-company users are redirected; preserve safe `next`. | company-scope, navigation | NA |
| `POST /company/select` | login / select | Reject unauthorized/inactive company IDs; persist selection; safe redirect. | company-scope, navigation | NA |
| `POST /company/all` | login / select | Permit only all-company-capable users; clear selected company; safe redirect. | company-scope | NA |

### Customer JSON API (6)

All require `customers:view`, login, and an allowed active/all company. IDs are re-scoped before lookup; query `company_id` cannot widen access.

| Route | Required behavior | Existing tests | Status |
|---|---|---|---|
| `GET /customers` | Case-insensitive search; paginated customer master rows; stable customer JSON. | customer-profile | NA |
| `GET /customers/:id` | Profile, metrics, contacts/documents, and scoped summary JSON; 404 outside scope. | customer-profile | NA |
| `GET /customers/:id/invoices` | Scoped sales/invoice rows and balances in stable JSON. | customer-profile | NA |
| `GET /customers/:id/challans` | Scoped challan/transfer-derived rows in stable JSON. | customer-profile | NA |
| `GET /customers/:id/payments` | Scoped receipt/allocation rows in stable JSON. | customer-profile | NA |
| `GET /customers/:id/stock` | Scoped item/quantity/value view in stable JSON. | customer-profile | NA |

### Dashboard (2)

| Route | Access / scope | Required behavior | Existing tests | Status |
|---|---|---|---|---|
| `GET /dashboard/` | `dashboard:view` / active/all | Date-filtered KPIs, stock value/quantity, receivable/payable/due summaries and tools widget without N+1 queries. | navigation, tools-widget | NA |
| `GET /dashboard/calendar-events` | `dashboard:view` / active/all | Validate ISO `start/end`; return scoped due/payment/stock events as JSON. | tools-widget | NA |

### Masters (10 route patterns; five kinds)

Kinds are `items`, `customers`, `suppliers`, `companies`, and `stock-books`, mapped respectively to `items`, `customers`, `suppliers`, `companies`, and `stock_books` permission modules. Master pages retain active/inactive filters, case-insensitive code/name search, unique code/name validation, integrity-error messaging, audit snapshots, and kind-specific form rules.

| Route | Access / scope | Required behavior | Existing tests | Status |
|---|---|---|---|---|
| `GET /masters/` | login / active/all | Redirect to items list. | navigation | NA |
| `GET /masters/:kind` | dynamic `view` / active/all | Reject unknown kind; list filtered/searched records; customer list uses profile service and company scope. | master-validation, customer-profile, navigation | NA |
| `GET /masters/customers/:id` | `customers:view` dynamic / document | Date-filtered profile, statement, metrics, contacts and transactions. | customer-profile | NA |
| `GET /masters/customers/:id/print` | `customers:view` / document | Printable customer statement with the same filters/totals. | customer-profile | NA |
| `GET /masters/customers/:id/export/:fmt` | `customers:export` / document | CSV/PDF only; same statement rows/totals and safe filename. | customer-profile | NA |
| `GET /masters/suppliers/:id/transactions` | `suppliers:view` / document | Scoped purchases/payments/outstanding activity and totals. | customer-profile | NA |
| `GET,POST /masters/:kind/new` | dynamic `create` / active/all | Kind-specific validation, uniqueness, company/book rules, atomic create and audit. | master-validation | NA |
| `GET,POST /masters/:kind/:id/edit` | dynamic `edit` / document | Scoped lookup, validation, atomic update and before/after audit. | master-validation | NA |
| `POST /masters/customers/:id/delete` | `customers:deactivate`/admin-equivalent / document | Refuse customer with transactions; otherwise delete atomically and audit. | master-validation | NA |
| `POST /masters/:kind/:id/deactivate` | dynamic `deactivate` / document | Prevent invalid dependency/last-required records; mark inactive and audit. | master-validation | NA |

### Payments and outstanding (10)

| Route | Access / scope | Required behavior | Existing tests | Status |
|---|---|---|---|---|
| `GET /finance/payments` | `payments:view` / active/all | List receipts/payments with parties, modes, allocations, actions, and scoped options. | navigation, payment-edit-delete | NA |
| `GET /finance/payments/:id/export/:fmt` | `payments:view` plus export semantics / document | CSV/PDF payment voucher; reject unsupported format. | entry-exports | NA |
| `GET /finance/payments/:id/print` | `payments:view` / document | Printable payment voucher. | entry-exports | NA |
| `GET,POST /finance/payments/:id/edit` | dynamic `payments:edit` / document | Only editable payment kinds; validate date/mode/reference/amount and allocations; atomic reallocation and audit. | payment-edit-delete | NA |
| `POST /finance/payments/:id/delete` | dynamic `payments:deactivate`/admin / document | Atomically reverse allocations/balances, delete and audit. | payment-edit-delete | NA |
| `POST /finance/payments/customer-receipt` | `payments:create` / active | Create receipt/advance, allocate oldest eligible receivables, update statuses, audit. | navigation, FIFO/report workflows | NA |
| `POST /finance/payments/supplier-payment` | `payments:create` / active | Create supplier payment/advance, allocate eligible payables, update statuses, audit. | navigation, reports | NA |
| `GET /finance/outstanding` | `outstanding:view` / active/all | Case-insensitive party search, deterministic sorting, grouped balances, exclude paid documents, totals. | report-totals | NA |
| `GET /finance/outstanding/customer/:company/:customer` | `outstanding:view` / document | Receivable rows, due status, edit links, activity and balance reconciliation. | report-totals | NA |
| `GET /finance/outstanding/supplier/:company/:supplier` | `outstanding:view` / document | Payable rows, due status, edit links and balance reconciliation. | report-totals | NA |

### Reports (5 route patterns; 23 named reports)

Every report requires `reports:view`; `?format=csv|pdf` additionally requires `reports:export`. All filters are validated and company-scoped before query execution. Totals must be computed from raw numeric values, not formatted strings.

| Route | Required behavior | Existing tests | Status |
|---|---|---|---|
| `GET /reports/` | Report catalog containing only authorized actions. | navigation | NA |
| `GET /reports/item-ledger` | Company/item/book/date filters, ordered movement/running quantity, highlight row, export URLs. | report-totals | NA |
| `GET /reports/customer-ledger` | Customer/month/company filters, monthly summaries, opening/closing/debit/credit metrics, export. | report-totals | NA |
| `GET /reports/customer-ledger/detail` | Required company/customer/month validation; daily ledger and balance, CSV/PDF. | report-totals | NA |
| `GET /reports/:name` | Whitelist name, build report, actions/totals, optional export; unknown names redirect with error. | company-scope, navigation, report-totals | NA |

Named `:name` contracts: `current-stock` (quantity/FIFO value/minimum/status), `fifo-valuation` (available FIFO value), `fifo-layers` (remaining layer detail), `stock-ledger` (ordered movements), `purchases`, `purchases-monthly`, `sales`, `sales-monthly`, `sales-by-type`, `gross-profit`, `customer-outstanding`, `supplier-outstanding`, `advances`, `payment-history`, `due-alerts`, `stock-alerts`, `inter-company`, `opening-summary`, `purchase-price-fluctuation`, `sale-price-fluctuation`, and `audit`. `item-ledger` and `customer-ledger` are dedicated routes above but remain catalog names. Each preserves current headers, row ordering, filters, row actions, grouped totals, and creator names.

### Transactions (35)

All require login and active/all company context. Routes labelled `document` must scope the fetched object and every related company/book/party. Create routes require `create` even though their GET/POST decorator states `view`; edit/delete checks currently occur inside handlers and must remain explicit.

| Route(s) | Access / scope | Required behavior | Existing tests | Status |
|---|---|---|---|---|
| `GET /transactions/reference/:kind` | login / active/all | Generate next reference for the whitelisted kind without collisions or cross-company leakage. | entry-exports | NA |
| `GET,POST /transactions/purchase` | `purchase:view`; POST `purchase:create` / active | List/create purchase; validate company/book/supplier/GST rules and lines; atomically create stock ledger, FIFO layers, payable, reference, audit. | company-scope, FIFO, purchase-edit | NA |
| `GET,POST /transactions/purchase/:id/edit` | `purchase:edit` / document | Header-only vs line edit rules; reverse/rebuild dependent stock/FIFO/payable atomically; audit. | purchase-edit | NA |
| `POST /transactions/purchase/:id/delete` | `purchase:deactivate`/admin / document | Refuse unsafe consumed/allocated state; reverse dependencies and audit atomically. | purchase-edit | NA |
| `GET /transactions/purchase/:id/export/:fmt`; `GET .../print` | `purchase:view` (+ export) / document | CSV/PDF/print entry with lines, tax and exact totals. | entry-exports | NA |
| `GET,POST /transactions/sale` | `sale:view`; POST `sale:create` / active | Validate customer/type/book/stock/lines; consume FIFO deterministically; create ledger, receivable, invoice reference and audit atomically. | FIFO, sale-transfer-edit | NA |
| `GET,POST /transactions/sale/:id/edit` | `sale:edit` / document | Safely reverse/reconsume FIFO, rebuild ledger/receivable and preserve payment invariants; audit. | sale-transfer-edit | NA |
| `POST /transactions/sale/:id/delete` | `sale:deactivate`/admin / document | Reject allocated/unsafe sale; reverse FIFO/ledger/receivable atomically; audit. | sale-transfer-edit | NA |
| `GET /transactions/sale/:id/export/:fmt`; `GET .../view`; `GET .../print` | `sale:view` (+ export) / document | Invoice view/CSV/PDF/print with customer, GST, lines and exact totals. | entry-exports, sale-transfer-edit | NA |
| `GET,POST /transactions/transfer` | `transfer:view`; POST `transfer:create` / active | Enforce source/destination company/book rules, quantity and pending workflow; source FIFO consumption, destination layers/ledger and audit atomically. | FIFO, sale-transfer-edit | NA |
| `GET,POST /transactions/transfer/:id/edit` | `transfer:edit` / document | Enforce editable state; reverse/rebuild both sides atomically and audit. | sale-transfer-edit | NA |
| `POST /transactions/transfer/:id/delete` | `transfer:deactivate`/admin / document | Reject unsafe state; reverse both sides and audit. | sale-transfer-edit | NA |
| `GET /transactions/transfer/:id/export/:fmt`; `GET .../print` | `transfer:view` (+ export) / document | Transfer note CSV/PDF/print with both companies/books and totals. | entry-exports | NA |
| `GET /transactions/opening` | `opening:view` / active/all | Unified opening stock, receivable, payable and advance sections with scoped options and rows. | navigation, opening-simplified | NA |
| `POST /transactions/opening/:section` | `opening:create` / active | Whitelist six sections: stock, pending-stock, receivable, payable, advance-received, advance-paid; validate and atomically create ledger/FIFO/balance/payment/audit effects. | opening-simplified, FIFO | NA |
| `POST /transactions/opening/stock/:id/delete`; `GET .../export/:fmt`; `GET .../print`; `GET,POST .../edit` | dynamic delete/edit/view / document | Preserve consumed-layer safeguards; reverse/rebuild opening stock ledger/FIFO; exports/print match entry. | opening-simplified, entry-exports | NA |
| `POST /transactions/opening/receivable/:id/delete`; `GET .../export/:fmt`; `GET .../print`; `GET,POST .../edit` | dynamic delete/edit/view / document | Preserve allocation safeguards; update exact balance/status; atomic audit; matching exports. | opening-simplified, entry-exports | NA |
| `POST /transactions/opening/payable/:id/delete`; `GET .../export/:fmt`; `GET .../print`; `GET,POST .../edit` | dynamic delete/edit/view / document | Preserve allocation safeguards; update exact balance/status; atomic audit; matching exports. | opening-simplified, entry-exports | NA |
| `POST /transactions/opening/advance/:id/delete`; `GET .../export/:fmt`; `GET .../print`; `GET,POST .../edit` | dynamic delete/edit/view / document | Preserve allocation safeguards and receipt/payment direction; atomic balance/audit updates; matching exports. | opening-simplified, entry-exports | NA |

### Users (4)

| Route | Access / scope | Required behavior | Existing tests | Status |
|---|---|---|---|---|
| `GET /users/` | `users:view` / active/all | List users and management actions without exposing hashes. | navigation | NA |
| `GET,POST /users/new` | `users:create` / active/all | Validate unique login ID, role/company restrictions, password hash, permission overrides and audit. | navigation | NA |
| `GET,POST /users/:id/edit` | `users:edit` / active/all | Prevent privilege/company escalation, optional password change, nullable override map, last-admin protection, audit. | navigation | NA |
| `POST /users/:id/deactivate` | `users:deactivate` / active/all | Prevent self/last-admin invalidation; deactivate and audit atomically. | navigation | NA |

## Template and service parity

All 41 Jinja templates are covered by the screen/response families below: auth (3), company (1), dashboard (1), masters (6), transactions including line partials (12), finance/outstanding (4), reports (5), customer API has JSON only, users (2), shared base/macros/widgets (3), print (1), and errors (3). The Worker may consolidate templates/components, but must retain rendered information and actions. Static logos, wordmarks, CSS, and behavior in `app/static/js/app.js` are product assets, not optional migration debris.

Service parity must be proven for audit, calendar events, customer ledger/profile/statement, entry exports, FIFO stock, item ledger, outstanding grouping, payment allocation/edit/delete, references, sale invoice PDF, seed/schema invariants, supplier profile, transaction create/edit/delete, and validators. The legacy services are the behavioral oracle; direct SQL substitutions require equivalent tests.

## Existing 92-test mapping

| Suite | Cases | Primary parity surface |
|---|---:|---|
| `test_company_scope.py` | 3 | Active-company isolation on purchase/report paths. |
| `test_customer_profile.py` | 5 | Customer master/profile/API/export and supplier activity. |
| `test_entry_exports.py` | 1 | All entry export/print links and response formats. |
| `test_fifo_workflows.py` | 3 | Purchase/sale/transfer FIFO and stock side effects. |
| `test_master_validation.py` | 7 | Master uniqueness, filtering, delete safeguards, form behavior. |
| `test_navigation.py` | 19 | Auth, company selection, permissions, navigation, errors, opening/report pages. |
| `test_opening_simplified.py` | 9 | Six opening flows plus edit/delete and validation invariants. |
| `test_payment_edit_delete.py` | 3 | Payment edit, reallocation and reversal/delete. |
| `test_purchase_edit.py` | 10 | Purchase edit/delete constraints and stock/FIFO/payable rebuild. |
| `test_report_totals.py` | 18 | Report filters, totals, outstanding, item/customer ledger. |
| `test_sale_transfer_edit.py` | 12 | Sale/transfer edit/delete/view and FIFO reversal/rebuild. |
| `test_tools_widget.py` | 2 | Dashboard tools markup and calendar JSON. |
| **Total** | **92** | Baseline acceptance corpus. |

These tests must not merely continue running against Flask. Each behavior needs a Worker/D1 parity test, plus negative cases for unauthenticated, forbidden role, wrong company, CSRF failure, malformed IDs/dates/amounts, unsupported format/kind/name, missing record, duplicate submission/idempotency, and atomic rollback.

## Explicitly excluded rich features

The source contains no chatbot, generative-AI assistant, WebSocket chat, push notification system, OCR ingestion, or live collaborative editing. They are intentional omissions, not parity gaps. Do not create D1/R2/Workers AI/Vectorize resources for them. Existing non-rich product features—including dashboards, reports, calendar events, exports, invoice PDFs, company branding, FIFO accounting, audit, customer JSON APIs, and permission overrides—are required parity.

## Completion gate

Migration is complete only when: all 81 route contracts are mapped to Worker handlers; every pattern and whitelisted variant has positive and negative tests; all 92 legacy behaviors have Worker equivalents; D1 query-count budgets and indexes are verified on representative production-scale fixtures; mutation failure injection proves atomic rollback; MySQL-to-D1 reconciliation matches row counts, key financial totals, balances, stock quantities, FIFO value, and audit linkage; R2 exports are private/signed where used; security headers/session/CSRF/rate limits are verified; and monitored production smoke tests pass with a rehearsed rollback path.
