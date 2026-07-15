import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

if (process.argv.includes('--remote') || process.env.CF_REMOTE === '1') {
  throw new Error('Local seed is intentionally prohibited from targeting remote D1');
}
const result = spawnSync(process.execPath, [
  resolve('node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'fastockflow-db', '--local', '--file', resolve('scripts/seed-local.sql'),
], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
