import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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
const run = (commandArgs) => {
  const result = spawnSync('npx', commandArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(['wrangler','d1','migrations','apply','fastockflow-db', remote ? '--remote' : '--local']);
for (const part of manifest.parts) run(['wrangler','d1','execute','fastockflow-db',remote ? '--remote' : '--local','--file',resolve(directory,part.file)]);
console.log(`Imported ${manifest.snapshot_id} into ${remote ? 'REMOTE fastockflow-db' : 'local fastockflow-db'}`);
