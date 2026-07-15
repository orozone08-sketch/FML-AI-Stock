import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const directory = resolve(args.find((value) => !value.startsWith('--')) ?? '');
const remote = args.includes('--remote');
if (remote && !args.includes('--confirm-production-read')) throw new Error('Remote verification requires --confirm-production-read');
const manifest = JSON.parse(await readFile(resolve(directory,'manifest.json'),'utf8'));
const queries = [];
for (const [table, count] of Object.entries(manifest.tables)) queries.push(`SELECT '${table}' metric, COUNT(*) actual, ${Number(count)} expected FROM ${table}`);
for (const [table, columns] of Object.entries(manifest.control_totals ?? {})) {
  for (const [column, expected] of Object.entries(columns)) queries.push(`SELECT '${table}.${column}' metric, COALESCE(SUM(${column}),0) actual, ${Number(expected)} expected FROM ${table}`);
}
queries.push("SELECT 'foreign_key_violations' metric, COUNT(*) actual, 0 expected FROM pragma_foreign_key_check");
const executable = process.execPath;
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
const failures = [];
for (let index = 0; index < queries.length; index += 8) {
  const batch = queries.slice(index, index + 8);
  const command = ['d1','execute','fastockflow-db',remote ? '--remote' : '--local','--json','--command',batch.join(';')];
  const result = spawnSync(executable, [wrangler, ...command], { encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr ?? String(result.error ?? 'Wrangler failed')); process.exit(result.status ?? 1); }
  const match = /\[\s*\{/.exec(result.stdout);
  if (!match) throw new Error(`Wrangler returned no JSON payload: ${result.stdout.slice(0,200)}`);
  const payload = JSON.parse(result.stdout.slice(match.index));
  failures.push(...payload.flatMap((entry) => entry.results ?? []).filter((row) => Number(row.actual) !== Number(row.expected)));
}
if (failures.length) { console.error(JSON.stringify(failures,null,2)); process.exit(2); }
console.log(`Verified ${queries.length} reconciliation controls for snapshot ${manifest.snapshot_id}`);
