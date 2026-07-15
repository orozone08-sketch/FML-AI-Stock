import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

test('snapshot import and reconciliation persist an auditable manifest lifecycle', async () => {
  const importer = await readFile(resolve('scripts/import-d1.mjs'), 'utf8');
  const verifier = await readFile(resolve('scripts/verify-migration.mjs'), 'utf8');
  assert.match(importer, /INSERT INTO migration_manifest/);
  assert.match(importer, /verification_status='PENDING'/);
  assert.match(importer, /backfill-audit-company-scope\.sql/);
  assert.match(importer, /Snapshot destination is not empty/);
  assert.match(importer, /reset-local\.mjs --empty/);
  assert.match(verifier, /verification_status='VERIFIED'/);
  assert.match(verifier, /no matching imported manifest row was marked verified/);
});
