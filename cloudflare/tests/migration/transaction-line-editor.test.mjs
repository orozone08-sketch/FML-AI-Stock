import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL("../../../app/static/js/app.js", import.meta.url);
const transactionsUrl = new URL("../../src/routes/transactions.ts", import.meta.url);

test("Cloudflare transaction line controls stay form-scoped and single-handled", async () => {
  const [script, transactions] = await Promise.all([
    readFile(scriptUrl, "utf8"),
    readFile(transactionsUrl, "utf8"),
  ]);

  assert.equal(script.match(/event\.target\.closest\("\[data-add-line\]"\)/g)?.length, 1);
  assert.equal(script.match(/event\.target\.closest\("\[data-remove-line\]"\)/g)?.length, 1);
  assert.match(script, /const form = addLine\.closest\("form"\);/);
  assert.match(script, /form\?\.querySelector\("\[data-line-grid\]"\)/);
  assert.doesNotMatch(script, /addLine\.previousElementSibling/);
  assert.doesNotMatch(script, /add\.previousElementSibling/);

  assert.equal((transactions.match(/<table id="lines" data-line-grid>/g) ?? []).length, 2);
  assert.match(transactions, /data-line-row/);
  assert.match(transactions, /data-remove-line/);
});
