import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Native helper checks require macOS.');
const temporary = mkdtempSync(path.join(tmpdir(), 'transcript-finder-test-'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = path.join(temporary, 'FinderHelper');
const origin = 'chrome-extension://lgjchnenkgchhcbkbfbakpejkkagjlfc/';
try {
  execFileSync('/usr/bin/swiftc', [
    '-O',
    path.join(root, 'native/FinderHelper.swift'),
    '-o',
    binary,
  ]);
  execFileSync(binary, ['--self-test'], { stdio: 'inherit' });
  function call(value) {
    const bytes = Buffer.from(JSON.stringify(value));
    const size = Buffer.alloc(4);
    size.writeUInt32LE(bytes.length);
    const result = spawnSync(binary, [origin], {
      input: Buffer.concat([size, bytes]),
      timeout: 5000,
    });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.length >= 4);
    assert.equal(result.stdout.readUInt32LE(0), result.stdout.length - 4);
    return JSON.parse(result.stdout.subarray(4).toString());
  }
  assert.deepEqual(call({ action: 'ping' }), { ok: true, version: 1 });
  assert.equal(call({ action: 'register', id: '../bad' }).ok, false);
  assert.equal(
    call({ action: 'reveal', id: '00112233-4455-6677-8899-aabbccddeeff', filename: '../file' }).ok,
    false
  );
  assert.equal(call({ action: 'execute', id: '00112233-4455-6677-8899-aabbccddeeff' }).ok, false);
  const denied = spawnSync(binary, ['chrome-extension://invalid/'], { timeout: 5000 });
  assert.equal(denied.status, 1);
  console.log(
    'Native framing, ping, origin and request validation passed. No Finder windows were opened.'
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
