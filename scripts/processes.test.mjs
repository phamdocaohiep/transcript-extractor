import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import {
  prepare,
  ownedPids,
  listProcesses,
  descendants,
  stopPids,
  acquireLease,
} from './processes.mjs';

async function fixture(t, listen = true) {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle fixture '));
  const entry = join(root, 'fixture.mjs');
  writeFileSync(
    entry,
    listen
      ? "import {createServer} from 'node:net'; const server=createServer(); server.listen(0,'127.0.0.1',()=>console.log(server.address().port));"
      : "console.log('ready'); setInterval(()=>{},1000);",
  );
  const child = spawn(process.execPath, [entry], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = await new Promise((done, reject) => {
    child.stdout.once('data', (data) => done(data.toString().trim()));
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Fixture exited before readiness.')));
  });
  t.after(async () => {
    await stopPids(descendants([child.pid], listProcesses()));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, child, port: Number(ready) };
}
function alive(pid) {
  // A terminated child may await reaping by this test runner; zombies cannot
  // execute work or hold listeners and must not be mistaken for active hosts.
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() !== '' && !result.stdout.includes('Z');
}

test('no -f preserves an unrelated listener and reports the conflict', async (t) => {
  const item = await fixture(t);
  const otherRoot = mkdtempSync(join(tmpdir(), 'other checkout '));
  t.after(() => rmSync(otherRoot, { recursive: true, force: true }));
  await assert.rejects(prepare(otherRoot, [item.port]), /conflict/i);
  assert.equal(alive(item.child.pid), true);
});

test('-f frees EVERY configured port and stops an owned worker without a port', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const worker = await fixture(t, false);
  await prepare(worker.root, [first.port, second.port], { force: true });
  assert.equal(alive(first.child.pid), false);
  assert.equal(alive(second.child.pid), false);
  assert.equal(alive(worker.child.pid), false);
  for (const number of [first.port, second.port]) {
    const server = createServer();
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(number, '127.0.0.1', done);
    });
    await new Promise((done) => server.close(done));
  }
});

test('--stop stops only checkout processes and preserves a foreign port owner', async (t) => {
  const owner = await fixture(t);
  const worker = await fixture(t, false);
  assert.ok(ownedPids(worker.root).includes(worker.child.pid));
  await prepare(worker.root, [owner.port], { stop: true });
  assert.equal(alive(worker.child.pid), false);
  assert.equal(alive(owner.child.pid), true);
});

test('process-tree cleanup includes a child that does not open a port', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tree fixture '));
  const entry = join(root, 'parent.mjs');
  writeFileSync(
    entry,
    "import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);",
  );
  const parent = spawn(process.execPath, [entry], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const childPid = await new Promise((done) =>
    parent.stdout.once('data', (data) => done(Number(data.toString().trim()))),
  );
  t.after(async () => {
    await stopPids(descendants([parent.pid], listProcesses()));
    rmSync(root, { recursive: true, force: true });
  });
  assert.ok(descendants([parent.pid], listProcesses()).includes(childPid));
  await prepare(root, [], { force: true });
  assert.equal(alive(parent.pid), false);
  assert.equal(alive(childPid), false);
});

test('a relative Windows launcher is identified by a live lease; stale PID identity is ignored', async (t) => {
  const worker = await fixture(t, false);
  const root = mkdtempSync(join(tmpdir(), 'lease fixture '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.cache'));
  const original = listProcesses().find((item) => item.pid === worker.child.pid);
  const relative = { ...original, command: 'node scripts/lifecycle.mjs dev', executable: 'node' };
  const file = join(root, '.cache/lifecycle.json');
  writeFileSync(
    file,
    JSON.stringify({ version: 1, root, pid: original.pid, started: original.started }),
  );
  assert.ok(ownedPids(root, [relative]).includes(original.pid));
  writeFileSync(
    file,
    JSON.stringify({ version: 1, root, pid: original.pid, started: 'stale-process-identity' }),
  );
  assert.equal(ownedPids(root, [relative]).includes(original.pid), false);
});

test('a lease prevents overlapping operations and can be released twice safely', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'exclusive fixture '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = acquireLease(root);
  assert.throws(() => acquireLease(root), /already running/);
  release();
  release();
  acquireLease(root)();
});
