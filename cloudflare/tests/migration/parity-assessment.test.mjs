import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const cloudflareRoot = fileURLToPath(new URL("../../", import.meta.url));
const contractPath = resolve(cloudflareRoot, "tests/parity/legacy-contract.json");
const matrixPath = resolve(cloudflareRoot, "../docs/CLOUDFLARE_PARITY_MATRIX.md");
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const matrix = readFileSync(matrixPath, "utf8");
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("every legacy route group has an evidence-backed current assessment", () => {
  assert.equal(contract.schemaVersion, 2);
  assert.equal(contract.routeGroups.reduce((sum, group) => sum + group.count, 0), contract.expected.routeDecorators);
  assert.equal(new Set(contract.routeGroups.map((group) => group.module)).size, contract.routeGroups.length);

  const unassessed = contract.routeGroups.filter((group) => group.status === "not-assessed");
  assert.deepEqual(unassessed.map((group) => group.module), []);
  for (const group of contract.routeGroups) {
    assert.ok(["implemented", "tested"].includes(group.status), `${group.module} has invalid current status ${group.status}`);
    assert.ok(Array.isArray(group.cloudflareTests) && group.cloudflareTests.length > 0, `${group.module} has no Cloudflare evidence paths`);
    for (const evidence of group.cloudflareTests) {
      assert.match(evidence, /^tests\/.+\.test\.(?:ts|mjs)$/);
      assert.ok(existsSync(resolve(cloudflareRoot, evidence)), `${group.module} evidence does not exist: ${evidence}`);
    }
  }
});

test("tested is reserved for groups with behavioral local automation", () => {
  const expected = {
    auth: "tested",
    company: "implemented",
    "customer-api": "tested",
    dashboard: "tested",
    masters: "implemented",
    payments: "tested",
    reports: "tested",
    transactions: "tested",
    users: "implemented",
  };
  assert.deepEqual(Object.fromEntries(contract.routeGroups.map((group) => [group.module, group.status])), expected);
  assert.doesNotMatch(matrix, /^\|.*\| NA \|$/m);
  for (const [module, status] of Object.entries(expected)) {
    const abbreviation = status === "tested" ? "T" : "I";
    assert.match(matrix, new RegExp("^\\| `" + escapeRegExp(module) + "` \\| .* \\| " + abbreviation + "(?: | —).*\\|$", "m"));
  }
});

test("production acceptance stays pending and rich omissions stay unchanged", () => {
  const acceptance = contract.liveProductionAcceptance;
  assert.equal(acceptance.status, "pending");
  assert.ok(existsSync(resolve(cloudflareRoot, acceptance.workflow)));
  assert.match(matrix, /Production acceptance[\s\S]*remains \*\*pending\*\*/);
  assert.deepEqual(contract.intentionalOmissions, [
    "chatbot",
    "generative AI assistant",
    "websocket chat",
    "push notifications",
    "OCR ingestion",
    "live collaborative editing",
  ]);
});
