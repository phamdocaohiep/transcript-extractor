import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startRun, exportDiagnostics, flushDiagnostics, classifyError } from './diagnostics';
let stored: Record<string, unknown>;
beforeEach(async () => {
  await flushDiagnostics();
  stored = {};
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: '4.3.0' }) },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          Object.assign(stored, value);
        }),
      },
    },
  });
});
afterEach(async () => {
  await flushDiagnostics();
  vi.unstubAllGlobals();
});
it('persists permission results in order and exports a readable support log', async () => {
  const trace = startRun('manual');
  trace('permission_needed', { origins: ['https://*.googlevideo.com/*'] });
  trace('permission_requested', { permission: 'host', origins: ['https://*.googlevideo.com/*'] });
  trace('permission_result', {
    permission: 'host',
    origins: ['https://*.googlevideo.com/*'],
    granted: true,
  });
  trace('file_saved', { format: 'video', extension: 'mp4' });
  const log = JSON.parse(await exportDiagnostics());
  expect(log.events.map((value: { event: string }) => value.event)).toEqual([
    'run_started',
    'permission_needed',
    'permission_requested',
    'permission_result',
    'file_saved',
  ]);
  expect(new Set(log.events.map((value: { run: string }) => value.run)).size).toBe(1);
  expect(log.version).toBe('4.3.0');
});
it('keeps simultaneous runs distinguishable by tab without storing their URLs', async () => {
  const first = startRun('manual', 42);
  const second = startRun('manual', 43);
  first('file_saved', { format: 'video' });
  second('run_paused', { code: 'host_access' });
  const log = JSON.parse(await exportDiagnostics());
  const runs = new Map(
    log.events.map((entry: { run: string; fields: { tab: number } }) => [
      entry.run,
      entry.fields.tab,
    ])
  );
  expect([...runs.values()].sort()).toEqual([42, 43]);
  expect(
    log.events.every(
      (entry: { run: string; fields: { tab: number } }) => runs.get(entry.run) === entry.fields.tab
    )
  ).toBe(true);
});
it('excludes signed URLs, cookies, tokens, titles, paths and arbitrary error text', async () => {
  const trace = startRun('manual');
  trace('request_started', {
    origin: 'https://r1.googlevideo.com/*',
    url: 'https://r1.googlevideo.com/videoplayback?sig=secret-signature',
    cookie: 'secret-cookie',
    token: 'secret-token',
    title: 'private-title',
    path: '/private/folder',
  } as never);
  trace('permission_needed', {
    origins: [
      'https://r1.googlevideo.com/*',
      'https://user:secret@host.test/*',
      'https://host.test/path?token=secret-token',
    ],
  });
  trace('request_failed', {
    code: classifyError(new Error('HTTP 403 for https://host.test/?token=secret-token')),
  });
  const text = await exportDiagnostics();
  for (const secret of [
    'secret-signature',
    'secret-cookie',
    'secret-token',
    'private-title',
    '/private/folder',
    'user:secret',
  ])
    expect(text).not.toContain(secret);
  expect(text).toContain('http_403');
});
it('bounds the log while retaining permission and file results', async () => {
  const trace = startRun('manual');
  trace('permission_result', { granted: true });
  await flushDiagnostics();
  const seed = stored.download_diagnostics_v1 as Array<Record<string, unknown>>;
  const run = seed[0].run;
  stored.download_diagnostics_v1 = [
    ...seed,
    ...Array.from({ length: 998 }, () => ({
      at: Date.now(),
      run,
      event: 'request_finished',
      fields: { status: 200 },
    })),
  ];
  trace('file_saved', { format: 'video' });
  const log = JSON.parse(await exportDiagnostics());
  expect(log.events).toHaveLength(1000);
  expect(log.events.some((entry: { event: string }) => entry.event === 'permission_result')).toBe(
    true
  );
  expect(log.events.at(-1).event).toBe('file_saved');
});
