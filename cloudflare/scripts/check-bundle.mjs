import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const limit = 3 * 1024 * 1024;
let total = 0;
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await walk(child);
    else total += (await stat(child)).size;
  }
}
await walk(resolve('dist/worker'));
if (total >= limit) throw new Error(`Worker bundle ${total} bytes exceeds ${limit} byte gate`);
console.log(`Worker dry-run bundle: ${total} / ${limit} bytes`);
