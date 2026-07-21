import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = readFileSync(new URL("../../scripts/live-production-acceptance.mjs", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../../../.github/workflows/cloudflare-live-acceptance.yml", import.meta.url), "utf8");

test("production acceptance script parses on the supported Node runtime", () => {
  execFileSync(process.execPath, ["--check", fileURLToPath(new URL("../../scripts/live-production-acceptance.mjs", import.meta.url))]);
});

test("production acceptance is manual and pinned to the permanent Cloudflare branch", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n\s+push:/);
  assert.match(workflow, /refs\/heads\/cloudflare\/serverless-migration/);
  assert.match(workflow, /RUN_PRODUCTION_ACCEPTANCE/);
  assert.doesNotMatch(workflow, /deploy\.yml|wrangler deploy|workflow_call/);
});

test("production acceptance has reverse cleanup and independent residue verification", () => {
  assert.match(script, /cleanup\.reverse\(\)/);
  assert.match(script, /lifecycleAuthorized/);
  assert.match(workflow, /FASTOCKFLOW_ACCEPTANCE_REQUIRE_FULL: '1'/);
  for (const step of ["opening void", "purchase void", "sale void", "transfer void", "payment delete", "R2 delete"])
    assert.ok(script.includes(step), `missing cleanup step: ${step}`);
  for (const table of ["opening_stocks", "purchases", "sales", "inter_company_transfers", "payments", "r2_objects"])
    assert.ok(workflow.includes(table), `missing residue check: ${table}`);
});

test("production acceptance resolves created payments by their rendered reference", () => {
  assert.match(script, /documentId\(await page\("\/finance\/payments"/);
  assert.match(script, /const reference = `\$\{prefix\}-PAY`/);
});

test("production acceptance covers session CSRF, idempotency, and R2 read variants", () => {
  for (const marker of ["fastock_public_csrf", "fastock_csrf", "idempotency_key", 'method: "HEAD"', "Range: \"bytes=3-11\"", 'method: "DELETE"'])
    assert.ok(script.includes(marker), `missing acceptance marker: ${marker}`);
});

test("production acceptance understands the legacy searchable item picker", () => {
  assert.match(script, /data-item-id/);
  assert.match(script, /name === "item_id\[\]"/);
});
