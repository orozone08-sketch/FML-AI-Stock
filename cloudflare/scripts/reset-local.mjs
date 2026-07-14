import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

await rm(resolve('.wrangler', 'state'), { recursive: true, force: true });
const commands = [[process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'd1', 'migrations', 'apply', 'fastockflow-db', '--local']], [process.execPath, ['scripts/seed-local.mjs']]];
if (process.argv.includes('--empty')) commands.pop();
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
