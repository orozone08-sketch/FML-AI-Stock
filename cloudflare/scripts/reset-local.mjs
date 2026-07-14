import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

await rm(resolve('.wrangler', 'state'), { recursive: true, force: true });
const commands = [['npx', ['wrangler', 'd1', 'migrations', 'apply', 'fastockflow-db', '--local']], ['node', ['scripts/seed-local.mjs']]];
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
