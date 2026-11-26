import { spawnSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [argument, ...rest] = process.argv.slice(2);
if (!argument || rest.length) throw new Error('Usage: node examples/rebuild-r12.mjs <new-output-folder>');
const directory = resolve(argument);
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory);
for (const filename of ['rail-stations.txt', 'rail-integration.json']) {
  await copyFile(new URL(`./r12/${filename}`, import.meta.url), join(directory, filename));
}
for (const filename of ['generate-production.mjs', 'integrate-blueprint.mjs', 'package-blueprints.mjs']) {
  const script = fileURLToPath(new URL(`./r12/source/${filename}`, import.meta.url));
  const run = spawnSync(process.execPath, [script, directory], { stdio: 'inherit' });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`R12 rebuild failed at ${filename}`);
}
