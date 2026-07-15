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
run(['wrangler','d1','migrations','apply','fastockflow-db', remote ? '--remote' : '--local']);
run(['wrangler','d1','execute','fastockflow-db',remote ? '--remote' : '--local','--command',
  'CREATE TABLE IF NOT EXISTS _snapshot_import_parts (snapshot_id TEXT NOT NULL, part_file TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (snapshot_id, part_file))']);
const tempDirectory = await mkdtemp(resolve(tmpdir(), 'fastockflow-import-'));
try {
  for (const part of manifest.parts) {
    const checkSql = `SELECT COUNT(*) AS imported FROM _snapshot_import_parts WHERE snapshot_id='${manifest.snapshot_id}' AND part_file='${part.file}'`;
    const output = run(['wrangler','d1','execute','fastockflow-db',remote ? '--remote' : '--local','--json','--command',checkSql], true);
    const start = output.indexOf('[{');
    const payload = start >= 0 ? JSON.parse(output.slice(start)) : [];
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
  run(['wrangler','d1','execute','fastockflow-db',remote ? '--remote' : '--local','--file',resolve('scripts/rebuild-inventory-balances.sql')]);
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
console.log(`Imported ${manifest.snapshot_id} and rebuilt inventory balances in ${remote ? 'REMOTE fastockflow-db' : 'local fastockflow-db'}`);
