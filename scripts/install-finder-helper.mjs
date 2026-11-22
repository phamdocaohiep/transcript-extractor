import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const id = process.argv[process.argv.indexOf('--extension-id') + 1];
if (
  process.platform !== 'darwin' ||
  !process.argv.includes('--extension-id') ||
  !/^[a-p]{32}$/.test(id || '')
) {
  console.error(
    'On macOS, run: npm run helper:install -- --extension-id <ID from chrome://extensions>'
  );
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = 'com.transcript_extractor.finder';
const base = path.join(homedir(), 'Library/Application Support/Transcript Extractor');
const manifests = path.join(
  homedir(),
  'Library/Application Support/Google/Chrome/NativeMessagingHosts'
);
const binary = path.join(base, 'FinderHelper');
const manifest = path.join(manifests, `${host}.json`);
const temporary = mkdtempSync(path.join(tmpdir(), 'transcript-finder-'));
try {
  execFileSync(
    '/usr/bin/swiftc',
    [
      '-O',
      path.join(root, 'native/FinderHelper.swift'),
      '-o',
      path.join(temporary, 'FinderHelper'),
    ],
    { stdio: 'inherit' }
  );
  execFileSync(path.join(temporary, 'FinderHelper'), ['--self-test'], { stdio: 'inherit' });
  let origins = [];
  try {
    origins = JSON.parse(readFileSync(manifest, 'utf8')).allowed_origins || [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const allowed = [
    ...new Set([
      ...origins.filter(value => /^chrome-extension:\/\/[a-p]{32}\/$/.test(value)),
      `chrome-extension://${id}/`,
    ]),
  ];
  mkdirSync(base, { recursive: true, mode: 0o700 });
  mkdirSync(manifests, { recursive: true });
  copyFileSync(path.join(temporary, 'FinderHelper'), binary);
  chmodSync(binary, 0o755);
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        name: host,
        description: 'Reveal connected Transcript Extractor files in Finder',
        path: binary,
        type: 'stdio',
        allowed_origins: allowed,
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );
  chmodSync(manifest, 0o600);
  console.log(
    `Finder helper installed for extension ${id}. In Settings, connect your download folder once.`
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
