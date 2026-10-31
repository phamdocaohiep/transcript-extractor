import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root, 'script')))
  throw new Error('Use only scripts; remove the obsolete singular directory.');
for (const action of ['dev', 'pro', 'pub-dev', 'pub-pro']) {
  for (const suffix of ['sh', 'ps1']) {
    const name = `scripts/${action}.${suffix}`;
    if (!existsSync(resolve(root, name))) throw new Error(`Missing entrypoint: ${name}`);
    if (!readFileSync(resolve(root, name), 'utf8').includes(action))
      throw new Error(`Incorrect dispatch: ${name}`);
  }
}
for (const old of ['dev.sh', 'dev-start.sh', 'pro-start.sh', 'pub-dev.sh', 'pub-pro.sh']) {
  if (existsSync(resolve(root, old))) throw new Error(`Obsolete root entrypoint: ${old}`);
}
const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts;
for (const [alias, action] of [
  ['dev:start', 'dev'],
  ['pro:start', 'pro'],
  ['pub:dev', 'pub-dev'],
  ['pub:pro', 'pub-pro'],
]) {
  if (scripts[alias] !== `node scripts/lifecycle.mjs ${action}`)
    throw new Error(`Incorrect package alias: ${alias}`);
}
console.log('Lifecycle entrypoints and package aliases are consistent.');
