import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const directory = resolve(args.find((value) => !value.startsWith('--')) ?? '');
const remote = args.includes('--remote');
const confirmed = args.includes('--confirm-production-import');
const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
if (!Array.isArray(manifest.parts) || !manifest.snapshot_id) throw new Error('Invalid export manifest');
if (remote) {
  if (!confirmed) throw new Error('Remote import requires --confirm-production-import');
  if (process.env.CLOUDFLARE_ACCOUNT_ID !== process.env.EXPECTED_CLOUDFLARE_ACCOUNT_ID) throw new Error('Cloudflare account identity mismatch');
  if (!process.env.EXPECTED_D1_DATABASE_ID || process.env.EXPECTED_D1_DATABASE_ID === '00000000-0000-0000-0000-000000000000') throw new Error('Expected production D1 ID is missing');
  if (process.env.EXPECTED_D1_DATABASE_NAME !== 'fastockflow-db') throw new Error('Expected D1 name must be fastockflow-db');
}
for (const part of manifest.parts) {
  const path = resolve(directory, part.file);
  if ((await stat(path)).size > 5 * 1024 * 1024) throw new Error(`${part.file} exceeds 5 MiB import guard`);
  const digest = createHash('sha256').update(await readFile(path)).digest('hex');
  if (digest !== part.sha256) throw new Error(`Checksum mismatch: ${part.file}`);
}
const executable = process.execPath;
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
const run = (commandArgs, capture = false) => {
  const result = spawnSync(executable, [wrangler, ...commandArgs.slice(1)], capture ? { encoding: 'utf8' } : { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout ?? '';
};
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const wranglerJson = (output) => {
  const match = /\[\s*\{/.exec(output);
  return match ? JSON.parse(output.slice(match.index)) : [];
};
run(['wrangler','d1','migrations','apply','fastockflow-db', remote ? '--remote' : '--local']);
run(['wrangler','d1','execute','fastockflow-db',remote ? '--remote' : '--local','--command',
  'CREATE TABLE IF NOT EXISTS _snapshot_import_parts (snapshot_id TEXT NOT NULL, part_file TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (snapshot_id, part_file))']);
const checkpointOutput = run(['wrangler','d1','execute','fastockflow-db',remote ? '--remote' : '--local','--json','--command',
  `SELECT COUNT(*) checkpoints FROM _snapshot_import_parts WHERE snapshot_id=${literal(manifest.snapshot_id)}`], true);
const checkpointPayload = wranglerJson(checkpointOutput);
if (Number(checkpointPayload?.[0]?.results?.[0]?.checkpoints ?? 0) === 0) {
  const tables = Object.keys(manifest.tables ?? {});
  const occupied = [];
  for (let index = 0; index < tables.length; index += 8) {
    const batch = tables.slice(index, index + 8);
    const output = run(['wrangler','d1','execute','fastockflow-db',remote ? '--remote' : '--local','--json','--command',
      batch.map((table) => `SELECT ${literal(table)} table_name,COUNT(*) row_count FROM ${table}`).join(';')], true);
    const payload = wranglerJson(output);
    occupied.push(...payload.flatMap((entry) => entry.results ?? []).filter((row) => Number(row.row_count) > 0));
  }
  if (occupied.length) {
    const summary = occupied.map((row) => `${row.table_name}=${row.row_count}`).join(', ');
    throw new Error(`Snapshot destination is not empty (${summary}). Restore/reset to a clean destination before the first import; for local verification use node scripts/reset-local.mjs --empty.`);
  }
}
const tempDirectory = await mkdtemp(resolve(tmpdir(), 'fastockflow-import-'));
try {
  for (const part of manifest.parts) {
    const checkSql = `SELECT COUNT(*) AS imported FROM _snapshot_import_parts WHERE snapshot_id='${manifest.snapshot_id}' AND part_file='${part.file}'`;
    const output = run(['wrangler','d1','execute','fastockflow-db',remote ? '--remote' : '--local','--json','--command',checkSql], true);
    const payload = wranglerJson(output);
    if (Number(payload?.[0]?.results?.[0]?.imported) === 1) {
      console.log(`Skipping checkpointed part ${part.file}`);
      continue;
    }
    const original = await readFile(resolve(directory, part.file), 'utf8');
    const marker = `INSERT INTO _snapshot_import_parts (snapshot_id,part_file) VALUES ('${manifest.snapshot_id}','${part.file}');`;
    let sql = original;
    if (remote) {
      sql = sql.replace(/^PRAGMA foreign_keys\s*=\s*ON;\s*/im, '').replace(/^BEGIN TRANSACTION;\s*/im, '').replace(/COMMIT;\s*$/i, marker);
    } else {
      sql = sql.replace(/COMMIT;\s*$/i, `${marker}\nCOMMIT;`);
    }
    if (sql === original) throw new Error(`${part.file} has no final COMMIT checkpoint boundary`);
    const checkpointedPath = resolve(tempDirectory, part.file);
    await writeFile(checkpointedPath, sql);
    run(['wrangler','d1','execute','fastockflow-db',remote ? '--remote' : '--local','--file',checkpointedPath]);
  }
  run(['wrangler','d1','execute','fastockflow-db',remote ? '--remote' : '--local','--file',resolve('scripts/backfill-audit-company-scope.sql')]);
  run(['wrangler','d1','execute','fastockflow-db',remote ? '--remote' : '--local','--file',resolve('scripts/rebuild-inventory-balances.sql')]);
  const snapshotId = literal(manifest.snapshot_id);
  const databaseDigest = literal(manifest.source_database_sha256 ?? manifest.source_database_digest ?? 'unknown');
  const snapshotAt = literal(manifest.snapshot_at);
  const tableCounts = literal(JSON.stringify(manifest.tables ?? {}));
  const controlTotals = literal(JSON.stringify(manifest.control_totals ?? {}));
  run(['wrangler','d1','execute','fastockflow-db',remote ? '--remote' : '--local','--command',
    `INSERT INTO migration_manifest(source_snapshot_id,source_database_digest,snapshot_at,table_counts_json,control_totals_json,imported_at,verification_status)
     SELECT ${snapshotId},${databaseDigest},${snapshotAt},${tableCounts},${controlTotals},CURRENT_TIMESTAMP,'PENDING'
     WHERE NOT EXISTS(SELECT 1 FROM migration_manifest WHERE source_snapshot_id=${snapshotId});
     UPDATE migration_manifest SET imported_at=CURRENT_TIMESTAMP,verified_at=NULL,verification_status='PENDING'
     WHERE source_snapshot_id=${snapshotId} AND source_database_digest=${databaseDigest}
       AND table_counts_json=${tableCounts} AND control_totals_json=${controlTotals};`]);
  const recorded = run(['wrangler','d1','execute','fastockflow-db',remote ? '--remote' : '--local','--json','--command',
    `SELECT COUNT(*) matched FROM migration_manifest WHERE source_snapshot_id=${snapshotId} AND source_database_digest=${databaseDigest}
       AND table_counts_json=${tableCounts} AND control_totals_json=${controlTotals} AND verification_status='PENDING'`], true);
  const recordedPayload = wranglerJson(recorded);
  if (Number(recordedPayload?.[0]?.results?.[0]?.matched) !== 1) throw new Error(`Snapshot ${manifest.snapshot_id} could not be recorded as a pending migration manifest`);
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
console.log(`Imported ${manifest.snapshot_id} and rebuilt inventory balances in ${remote ? 'REMOTE fastockflow-db' : 'local fastockflow-db'}`);
