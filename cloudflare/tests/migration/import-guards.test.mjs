import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('remote import cannot run without explicit production confirmation', async () => {
  const directory = await mkdtemp(join(tmpdir(),'fastockflow-guard-'));
  await writeFile(join(directory,'manifest.json'), JSON.stringify({ snapshot_id:'test', parts:[], tables:{} }));
  const result = spawnSync(process.execPath,[resolve('scripts/import-d1.mjs'),directory,'--remote'],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/confirm-production-import/);
});
