#!/usr/bin/env node

import { writeFileSync } from "node:fs";

const baseUrl = requiredUrl("FASTOCKFLOW_WORKER_URL");
const loginId = required("FASTOCKFLOW_SMOKE_LOGIN_ID");
const password = required("FASTOCKFLOW_SMOKE_PASSWORD");
const companyId = positiveInteger(required("FASTOCKFLOW_SMOKE_COMPANY_ID"), "FASTOCKFLOW_SMOKE_COMPANY_ID");
const destinationCompanyId = optionalPositiveInteger(process.env.FASTOCKFLOW_ACCEPTANCE_DEST_COMPANY_ID);
const destinationStockBookId = optionalPositiveInteger(process.env.FASTOCKFLOW_ACCEPTANCE_DEST_STOCK_BOOK_ID);
const sourceStockBookId = optionalPositiveInteger(process.env.FASTOCKFLOW_ACCEPTANCE_SOURCE_STOCK_BOOK_ID);
const purchaseDocumentType = documentType(process.env.FASTOCKFLOW_ACCEPTANCE_PURCHASE_TYPE, "purchase");
const saleDocumentType = documentType(process.env.FASTOCKFLOW_ACCEPTANCE_SALE_TYPE, "sale");
const resultFile = process.env.FASTOCKFLOW_ACCEPTANCE_RESULT_FILE;
const prefixFile = process.env.FASTOCKFLOW_ACCEPTANCE_PREFIX_FILE;
const requireFullMutationCoverage = process.env.FASTOCKFLOW_ACCEPTANCE_REQUIRE_FULL === "1";
const prefix = `QA-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const today = new Date().toISOString().slice(0, 10);
const jar = new Map();
const cleanup = [];
const report = {
  prefix,
  baseUrl: baseUrl.origin,
  companyId,
  startedAt: new Date().toISOString(),
  steps: {},
  cleanup: [],
  limitations: [],
  activeResidue: [],
  fileId: null,
  success: false,
};

if (prefixFile) writeFileSync(prefixFile, `${prefix}\n`, { encoding: "utf8", mode: 0o600 });

function persistReport() {
  if (resultFile) writeFileSync(resultFile, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredUrl(name) {
  const value = new URL(required(name));
  if (value.protocol !== "https:") throw new Error(`${name} must be an HTTPS URL.`);
  value.pathname = "/";
  value.search = "";
  value.hash = "";
  return value;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer.`);
  return number;
}

function optionalPositiveInteger(value) {
  return value?.trim() ? positiveInteger(value, "destination fixture ID") : null;
}

function documentType(value, kind) {
  const normalized = String(value ?? "GST").trim().toUpperCase();
  if (!["GST", "CASH"].includes(normalized)) throw new Error(`No permitted ${kind} document type was resolved.`);
  return normalized;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cookiesFrom(response) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  for (const header of values) {
    // Session cookies do not contain an Expires attribute, so splitting at a
    // comma before another cookie name is safe on the supported Worker path.
    for (const item of header.split(/,(?=\s*[^;,=]+=[^;,]*)/)) {
      const [pair] = item.trim().split(";", 1);
      const equals = pair.indexOf("=");
      if (equals <= 0) continue;
      const name = pair.slice(0, equals);
      const value = pair.slice(equals + 1);
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
  }
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  if (jar.size) headers.set("Cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    headers,
    redirect: options.redirect ?? "manual",
    signal: options.signal ?? AbortSignal.timeout(15_000),
  });
  cookiesFrom(response);
  return response;
}

async function responseText(response) {
  return response.text().catch(() => "");
}

async function expectStatus(response, allowed, label) {
  if (allowed.includes(response.status)) return response;
  const body = (await responseText(response)).replace(/\s+/g, " ").slice(0, 600);
  throw new Error(`${label} returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
}

function csrf() {
  const value = jar.get("fastock_csrf");
  if (!value) throw new Error("Authenticated CSRF cookie was not issued.");
  return decodeURIComponent(value);
}

function form(fields) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null) body.append(name, String(item));
    }
  }
  return body;
}

async function postForm(path, fields, label) {
  const response = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-CSRF-Token": csrf() },
    body: form({ ...fields, csrf_token: csrf() }),
  });
  return expectStatus(response, [303], label);
}

async function lifecycleAuthorized(editPath, deletePath, label) {
  const edit = await request(editPath);
  if (edit.status === 403) return false;
  await expectStatus(edit, [404], `${label} edit authorization probe`);
  const deletion = await request(deletePath, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-CSRF-Token": csrf() },
    body: form({ csrf_token: csrf(), idempotency_key: `${prefix}-${label.toUpperCase()}-PROBE` }),
  });
  if (deletion.status === 403) return false;
  await expectStatus(deletion, [404], `${label} delete authorization probe`);
  return true;
}

function selectValues(html, name) {
  const match = new RegExp(`<select[^>]*name=["']${escapeRegex(name)}["'][^>]*>([\\s\\S]*?)<\\/select>`, "i").exec(html);
  const values = match
    ? [...match[1].matchAll(/<option[^>]*value=["']([^"']*)["'][^>]*>/gi)].map((option) => option[1])
    : name === "item_id[]"
      ? [...html.matchAll(/<option[^>]*data-item-id=["']([^"']*)["'][^>]*>/gi)].map((option) => option[1])
      : [];
  return values
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

function hasMutationForm(html, marker) {
  return html.includes(marker) && html.includes('name="idempotency_key"');
}

function documentId(html, reference, route) {
  const row = html.split(/<tr[^>]*>/i).find((part) => part.includes(reference));
  const match = row && new RegExp(`href=["']${escapeRegex(route)}/(\\d+)/edit["']`, "i").exec(row);
  if (!match) throw new Error(`Could not resolve the ID for ${reference} from ${route}.`);
  return positiveInteger(match[1], `${reference} ID`);
}

function openingId(html, reference) {
  const row = html.split(/<tr[^>]*>/i).find((part) => part.includes(reference));
  const match = row && /href=["']\/transactions\/opening\/stock\/(\d+)\/edit["']/i.exec(row);
  if (!match) throw new Error(`Could not resolve opening stock ${reference}.`);
  return positiveInteger(match[1], `${reference} ID`);
}

async function page(path, label) {
  const response = await expectStatus(await request(path), [200], label);
  return responseText(response);
}

async function registerCleanup(label, action) {
  cleanup.push({ label, action, complete: false });
}

async function runCleanup() {
  for (const entry of cleanup.reverse()) {
    try {
      await entry.action();
      entry.complete = true;
      report.cleanup.push({ step: entry.label, status: "complete" });
    } catch (error) {
      report.cleanup.push({ step: entry.label, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
    persistReport();
  }
}

async function login() {
  const pageResponse = await expectStatus(await request(`/login/company/${companyId}`), [200], "login form");
  const html = await responseText(pageResponse);
  const publicToken = /name=["']csrf_token["'] value=["']([^"']+)["']/i.exec(html)?.[1];
  if (!publicToken || !jar.has("fastock_public_csrf")) throw new Error("Public login CSRF token/cookie is missing.");
  const response = await request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ csrf_token: publicToken, email: loginId, password, company_id: companyId }),
  });
  if (response.status !== 303) throw new Error(`Login returned HTTP ${response.status}.`);
  if (!["/dashboard", "/dashboard/"].includes(response.headers.get("location"))) throw new Error(`Unexpected login redirect: ${response.headers.get("location")}`);
  if (!jar.has("fastock_session") || !jar.has("fastock_csrf")) throw new Error("Login did not issue session cookies.");
  await expectStatus(await request("/dashboard"), [200], "authenticated dashboard");
  report.steps.login = { status: "passed" };
}

async function r2Acceptance() {
  const status = await expectStatus(await request("/files/status"), [200], "R2 status");
  const statusBody = await status.json();
  if (statusBody.ok !== true || statusBody.storage !== true) throw new Error("R2 status response is not ready.");

  const bytes = new TextEncoder().encode(`${prefix}:0123456789`);
  const upload = await request("/files/upload", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "Content-Length": String(bytes.byteLength),
      "X-Company-Id": String(companyId),
      "X-CSRF-Token": csrf(),
    },
    body: bytes,
  });
  if (upload.status === 403) {
    report.steps.r2 = { status: "skipped", reason: "smoke account cannot upload files" };
    report.limitations.push("R2 mutations were skipped because the smoke account is VIEWER or lacks upload authority.");
    return;
  }
  await expectStatus(upload, [201], "R2 upload");
  const metadata = await upload.json();
  const id = positiveInteger(metadata.id, "uploaded file ID");
  report.fileId = id;
  // Persist the R2 metadata ID immediately so the workflow can find residue
  // even if the process is interrupted before its normal finally block.
  persistReport();
  await registerCleanup("R2 delete", async () => {
    const response = await request(`/files/${id}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf() } });
    await expectStatus(response, [204, 404], "R2 cleanup delete");
  });

  const head = await expectStatus(await request(`/files/${id}`, { method: "HEAD" }), [200], "R2 HEAD");
  if (Number(head.headers.get("content-length")) !== bytes.byteLength || head.headers.get("accept-ranges") !== "bytes") throw new Error("R2 HEAD metadata mismatch.");
  const partial = await expectStatus(await request(`/files/${id}`, { headers: { Range: "bytes=3-11" } }), [206], "R2 range read");
  if ((await partial.arrayBuffer()).byteLength !== 9 || partial.headers.get("content-range") !== `bytes 3-11/${bytes.byteLength}`) throw new Error("R2 range response mismatch.");
  const download = await expectStatus(await request(`/files/${id}`), [200], "R2 download");
  if (Buffer.compare(Buffer.from(await download.arrayBuffer()), Buffer.from(bytes)) !== 0) throw new Error("R2 download bytes do not match upload.");
  report.steps.r2 = { status: "passed", fileId: id, bytes: bytes.byteLength };
}

async function openingAcceptance() {
  const response = await request("/transactions/opening/stock/new");
  if (response.status === 403) {
    report.steps.opening = { status: "skipped", reason: "no create permission" };
    report.limitations.push("Opening create/edit/void was skipped because the smoke account lacks opening-create permission.");
    return;
  }
  await expectStatus(response, [200], "opening stock form");
  const html = await responseText(response);
  if (!await lifecycleAuthorized("/transactions/opening/stock/0/edit", "/transactions/opening/stock/0/delete", "opening")) {
    report.steps.opening = { status: "skipped", reason: "incomplete lifecycle permission" };
    report.limitations.push("Opening mutations were skipped because the smoke account cannot safely edit and void its QA entry.");
    return;
  }
  const offeredBooks = selectValues(html, "stock_book_id");
  const bookId = sourceStockBookId ?? offeredBooks[0];
  const itemId = selectValues(html, "item_id[]")[0];
  if (!bookId || !offeredBooks.includes(bookId) || !itemId) throw new Error("Opening acceptance requires one offered active source stock book and item.");
  const createRef = `${prefix}-OPN`;
  const editRef = `${createRef}-E`;
  await postForm("/transactions/opening/stock", {
    company_id: companyId, stock_book_id: bookId, reference_number: createRef,
    document_date: today, "item_id[]": itemId, "quantity[]": "3", "rate[]": "11.25", "gst_percent[]": "0",
    remarks: prefix, idempotency_key: `${prefix}-OPN-C`,
  }, "opening create");
  let id;
  await registerCleanup("opening void", async () => {
    id ??= openingId(await page("/transactions/opening", "opening list during cleanup"), createRef);
    await postForm(`/transactions/opening/stock/${id}/delete`, { idempotency_key: `${prefix}-OPN-V` }, "opening cleanup void");
  });
  id = openingId(await page("/transactions/opening", "opening list after create"), createRef);
  await postForm(`/transactions/opening/stock/${id}/edit`, {
    company_id: companyId, stock_book_id: bookId, reference_number: editRef,
    document_date: today, "item_id[]": itemId, "quantity[]": "3", "rate[]": "11.50", "gst_percent[]": "0",
    remarks: `${prefix} edited`, idempotency_key: `${prefix}-OPN-E`,
  }, "opening edit");
  openingId(await page("/transactions/opening", "opening list after edit"), editRef);
  report.steps.opening = { status: "passed", id, stockBookId: bookId, itemId };
  return { bookId, itemId };
}

async function purchaseAcceptance(fixture) {
  const html = await page("/transactions/purchase", "purchase page");
  if (!hasMutationForm(html, 'name="supplier_id"')) {
    report.steps.purchase = { status: "skipped", reason: "no create permission" };
    report.limitations.push("Purchase create/edit/void was skipped because the smoke account lacks purchase-create permission.");
    return null;
  }
  if (!await lifecycleAuthorized("/transactions/purchase/0/edit", "/transactions/purchase/0/delete", "purchase")) {
    report.steps.purchase = { status: "skipped", reason: "incomplete lifecycle permission" };
    report.limitations.push("Purchase mutations were skipped because the smoke account cannot safely edit and void its QA purchase.");
    return null;
  }
  const offeredBooks = selectValues(html, "stock_book_id");
  const bookId = fixture?.bookId ?? sourceStockBookId ?? offeredBooks[0];
  const itemId = fixture?.itemId ?? selectValues(html, "item_id[]")[0];
  const supplierId = selectValues(html, "supplier_id")[0];
  if (!bookId || !offeredBooks.includes(bookId) || !itemId || !supplierId) throw new Error("Purchase acceptance requires an offered active stock book, item, and supplier.");
  const createRef = `${prefix}-PUR`;
  const editRef = `${createRef}-E`;
  await postForm("/transactions/purchase", {
    company_id: companyId, stock_book_id: bookId, supplier_id: supplierId,
    reference_number: createRef, document_date: today, due_date: today, document_type: purchaseDocumentType,
    "item_id[]": itemId, "quantity[]": "5", "rate[]": "12.00", "gst_percent[]": "0",
    remarks: prefix, idempotency_key: `${prefix}-PUR-C`,
  }, "purchase create");
  let id;
  await registerCleanup("purchase void", async () => {
    id ??= documentId(await page("/transactions/purchase", "purchase list during cleanup"), createRef, "/transactions/purchase");
    await postForm(`/transactions/purchase/${id}/delete`, { idempotency_key: `${prefix}-PUR-V` }, "purchase cleanup void");
  });
  id = documentId(await page("/transactions/purchase", "purchase list after create"), createRef, "/transactions/purchase");
  await postForm(`/transactions/purchase/${id}/edit`, {
    company_id: companyId, stock_book_id: bookId, supplier_id: supplierId,
    reference_number: editRef, document_date: today, due_date: today, document_type: purchaseDocumentType,
    "item_id[]": itemId, "quantity[]": "5", "rate[]": "12.25", "gst_percent[]": "0",
    remarks: `${prefix} edited`, idempotency_key: `${prefix}-PUR-E`,
  }, "purchase edit");
  documentId(await page("/transactions/purchase", "purchase list after edit"), editRef, "/transactions/purchase");
  report.steps.purchase = { status: "passed", id, stockBookId: bookId, itemId, supplierId };
  return { bookId, itemId };
}

async function saleAcceptance(fixture) {
  if (!fixture) {
    report.steps.sale = { status: "skipped", reason: "no safely-created stock fixture" };
    report.limitations.push("Sale mutations were skipped because the test could not create an isolated stock fixture.");
    return null;
  }
  const html = await page("/transactions/sale", "sale page");
  if (!hasMutationForm(html, 'name="customer_id"')) {
    report.steps.sale = { status: "skipped", reason: "no create permission" };
    report.limitations.push("Sale create/edit/void was skipped because the smoke account lacks sale-create permission.");
    return null;
  }
  if (!await lifecycleAuthorized("/transactions/sale/0/edit", "/transactions/sale/0/delete", "sale")) {
    report.steps.sale = { status: "skipped", reason: "incomplete lifecycle permission" };
    report.limitations.push("Sale mutations were skipped because the smoke account cannot safely edit and void its QA sale.");
    return null;
  }
  const customerId = selectValues(html, "customer_id")[0];
  if (!customerId) throw new Error("Sale acceptance requires an active customer.");
  const createRef = `${prefix}-SAL`;
  const editRef = `${createRef}-E`;
  await postForm("/transactions/sale", {
    company_id: companyId, stock_book_id: fixture.bookId, customer_id: customerId,
    reference_number: createRef, document_date: today, due_date: today, document_type: saleDocumentType,
    "item_id[]": fixture.itemId, "quantity[]": "1", "rate[]": "100.00", "gst_percent[]": "0",
    remarks: prefix, idempotency_key: `${prefix}-SAL-C`,
  }, "sale create");
  let id;
  await registerCleanup("sale void", async () => {
    id ??= documentId(await page("/transactions/sale", "sale list during cleanup"), createRef, "/transactions/sale");
    await postForm(`/transactions/sale/${id}/delete`, { idempotency_key: `${prefix}-SAL-V` }, "sale cleanup void");
  });
  id = documentId(await page("/transactions/sale", "sale list after create"), createRef, "/transactions/sale");
  await postForm(`/transactions/sale/${id}/edit`, {
    company_id: companyId, stock_book_id: fixture.bookId, customer_id: customerId,
    reference_number: editRef, document_date: today, due_date: today, document_type: saleDocumentType,
    "item_id[]": fixture.itemId, "quantity[]": "1", "rate[]": "101.00", "gst_percent[]": "0",
    remarks: `${prefix} edited`, idempotency_key: `${prefix}-SAL-E`,
  }, "sale edit");
  documentId(await page("/transactions/sale", "sale list after edit"), editRef, "/transactions/sale");
  report.steps.sale = { status: "passed", id, customerId, reference: editRef };
  return { id, customerId, reference: editRef };
}

async function paymentAcceptance(sale) {
  if (!sale) {
    report.steps.payment = { status: "skipped", reason: "no isolated sale target" };
    report.limitations.push("Payment mutations were skipped because no isolated QA receivable was available.");
    return;
  }
  const html = await page("/finance/payments", "payments page");
  if (!hasMutationForm(html, 'name="party_id"')) {
    report.steps.payment = { status: "skipped", reason: "no create permission" };
    report.limitations.push("Payment create/edit/delete was skipped because the smoke account lacks payment-create permission.");
    return;
  }
  if (!await lifecycleAuthorized("/finance/payments/0/edit", "/finance/payments/0/delete", "payment")) {
    report.steps.payment = { status: "skipped", reason: "incomplete lifecycle permission" };
    report.limitations.push("Payment mutations were skipped because the smoke account cannot safely edit and delete its QA payment.");
    return;
  }
  const targetBlock = new RegExp(`<option value=["'](\\d+)["'][^>]*>[^<]*${escapeRegex(sale.reference)}[^<]*<\\/option>`, "i").exec(html);
  const targetId = targetBlock ? positiveInteger(targetBlock[1], "QA receivable ID") : null;
  if (!targetId) throw new Error("The QA sale receivable was not offered as a payment target.");
  const reference = `${prefix}-PAY`;
  await postForm("/finance/payments/customer-receipt", {
    company_id: companyId, party_id: sale.customerId, target_id: targetId,
    payment_date: today, mode: "BANK", reference_number: reference, amount: "1.00",
    remarks: prefix, idempotency_key: `${prefix}-PAY-C`,
  }, "payment create");
  let id;
  await registerCleanup("payment delete", async () => {
    id ??= documentId(await page("/finance/payments", "payment list during cleanup"), reference, "/finance/payments");
    await postForm(`/finance/payments/${id}/delete`, { idempotency_key: `${prefix}-PAY-D` }, "payment cleanup delete");
  });
  id = documentId(await page("/finance/payments", "payment list after create"), reference, "/finance/payments");
  await postForm(`/finance/payments/${id}/edit`, {
    company_id: companyId, party_id: sale.customerId, target_id: targetId,
    payment_date: today, mode: "UPI", reference_number: reference, amount: "2.00",
    remarks: `${prefix} edited`, idempotency_key: `${prefix}-PAY-E`,
  }, "payment edit");
  documentId(await page("/finance/payments", "payment list after edit"), reference, "/finance/payments");
  report.steps.payment = { status: "passed", id, targetId };
}

async function transferAcceptance(fixture) {
  if (!fixture) {
    report.steps.transfer = { status: "skipped", reason: "no safely-created stock fixture" };
    report.limitations.push("Transfer mutations were skipped because the test could not create an isolated stock fixture.");
    return;
  }
  const html = await page("/transactions/transfer", "transfer page");
  if (!hasMutationForm(html, 'name="to_company_id"')) {
    report.steps.transfer = { status: "skipped", reason: "no create permission" };
    report.limitations.push("Transfer create/edit/void was skipped because the smoke account lacks transfer-create permission.");
    return;
  }
  if (!await lifecycleAuthorized("/transactions/transfer/0/edit", "/transactions/transfer/0/delete", "transfer")) {
    report.steps.transfer = { status: "skipped", reason: "incomplete lifecycle permission" };
    report.limitations.push("Transfer mutations were skipped because the smoke account cannot safely edit and void its QA transfer.");
    return;
  }
  if (!destinationCompanyId || !destinationStockBookId) {
    report.steps.transfer = { status: "skipped", reason: "no destination fixture" };
    report.limitations.push("Transfer mutations were skipped because no different active company with an active stock book was available.");
    return;
  }
  const createRef = `${prefix}-TRF`;
  const editRef = `${createRef}-E`;
  const fields = {
    from_company_id: companyId, from_stock_book_id: fixture.bookId,
    to_company_id: destinationCompanyId, to_stock_book_id: destinationStockBookId,
    reference_number: createRef, document_date: today, reason: prefix,
    "item_id[]": fixture.itemId, "quantity[]": "1", "rate[]": "0", "gst_percent[]": "0",
    remarks: prefix, idempotency_key: `${prefix}-TRF-C`,
  };
  await postForm("/transactions/transfer", fields, "transfer create");
  let id;
  await registerCleanup("transfer void", async () => {
    id ??= documentId(await page("/transactions/transfer", "transfer list during cleanup"), createRef, "/transactions/transfer");
    await postForm(`/transactions/transfer/${id}/delete`, { idempotency_key: `${prefix}-TRF-V` }, "transfer cleanup void");
  });
  id = documentId(await page("/transactions/transfer", "transfer list after create"), createRef, "/transactions/transfer");
  await postForm(`/transactions/transfer/${id}/edit`, {
    ...fields, reference_number: editRef, remarks: `${prefix} edited`, idempotency_key: `${prefix}-TRF-E`,
  }, "transfer edit");
  documentId(await page("/transactions/transfer", "transfer list after edit"), editRef, "/transactions/transfer");
  report.steps.transfer = { status: "passed", id, destinationCompanyId, destinationStockBookId };
}

async function assertHttpResidue() {
  const checks = [
    ["/transactions/opening", "opening"], ["/transactions/purchase", "purchase"],
    ["/transactions/sale", "sale"], ["/transactions/transfer", "transfer"], ["/finance/payments", "payment"],
  ];
  for (const [path, kind] of checks) {
    const response = await request(path);
    if (response.status !== 200) continue;
    if ((await responseText(response)).includes(prefix)) report.activeResidue.push(kind);
  }
  if (report.fileId) {
    const response = await request(`/files/${report.fileId}`);
    if (response.status !== 404) report.activeResidue.push("r2");
  }
  if (report.activeResidue.length) throw new Error(`Active QA residue remains: ${report.activeResidue.join(", ")}`);
}

let failure;
try {
  await login();
  await r2Acceptance();
  const openingFixture = await openingAcceptance();
  const purchaseFixture = await purchaseAcceptance(openingFixture);
  const stockFixture = purchaseFixture ?? openingFixture;
  const sale = await saleAcceptance(stockFixture);
  await paymentAcceptance(sale);
  await transferAcceptance(stockFixture);
} catch (error) {
  failure = error;
} finally {
  await runCleanup();
  try {
    await assertHttpResidue();
  } catch (error) {
    failure ??= error;
  }
  try {
    if (jar.has("fastock_session")) await postForm("/logout", {}, "logout");
  } catch (error) {
    report.limitations.push(`Logout cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (requireFullMutationCoverage) {
    const missing = ["r2", "opening", "purchase", "sale", "payment", "transfer"]
      .filter((name) => report.steps[name]?.status !== "passed");
    if (missing.length) failure ??= new Error(`Full mutation coverage was required but not completed: ${missing.join(", ")}`);
  }
  const cleanupFailures = report.cleanup.filter((entry) => entry.status === "failed");
  if (cleanupFailures.length) failure ??= new Error(`${cleanupFailures.length} cleanup action(s) failed.`);
  report.finishedAt = new Date().toISOString();
  report.success = !failure;
  if (failure) report.error = failure instanceof Error ? failure.message : String(failure);
  persistReport();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (failure) throw failure;
