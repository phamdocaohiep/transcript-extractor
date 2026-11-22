import { beforeEach, expect, it, vi } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import {
  loadPreferences,
  savePreferences,
  saveDirectory,
  loadDirectory,
  PREFERENCES_KEY,
} from './preferences';
let stored: Record<string, unknown>;
beforeEach(() => {
  stored = {};
  vi.stubGlobal('indexedDB', indexedDB);
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: stored[key] }),
        set: async (value: Record<string, unknown>) => {
          Object.assign(stored, value);
        },
      },
    },
  });
});
it('keeps saved choices while supplying defaults for fields added by an update', async () => {
  stored[PREFERENCES_KEY] = { video: false };
  expect(await loadPreferences()).toEqual({ video: false, transcript: true, automatic: false });
  await savePreferences({ video: true, transcript: false, automatic: true });
  expect(await loadPreferences()).toEqual({ video: true, transcript: false, automatic: true });
});
it('restores the selected folder handle from a reopened database', async () => {
  const handle = { kind: 'directory', name: 'Saved downloads' } as FileSystemDirectoryHandle;
  await saveDirectory(handle);
  expect(await loadDirectory()).toEqual(handle);
});
it('keeps saved file locations separate from later destination changes', async () => {
  const first = { kind: 'directory', name: 'First' } as FileSystemDirectoryHandle;
  const second = { kind: 'directory', name: 'Second' } as FileSystemDirectoryHandle;
  await saveDirectory(first, 'location:example');
  await saveDirectory(second);
  expect(await loadDirectory('location:example')).toEqual(first);
  expect(await loadDirectory()).toEqual(second);
});
it('persists quality preferences and ignores invalid values from stored settings', async () => {
  await savePreferences({
    video: true,
    transcript: false,
    automatic: false,
    format: 'webm',
    maxHeight: 1080,
  });
  expect(await loadPreferences()).toMatchObject({ format: 'webm', maxHeight: 1080 });
  stored[PREFERENCES_KEY] = { format: 'mkv', maxHeight: -1 };
  expect(await loadPreferences()).not.toHaveProperty('format');
  expect(await loadPreferences()).not.toHaveProperty('maxHeight');
});
it('keeps automatic reload off unless explicitly enabled and persists that choice', async () => {
  expect((await loadPreferences()).reload).not.toBe(true);
  await savePreferences({ video: true, transcript: true, automatic: false, reload: true });
  expect((await loadPreferences()).reload).toBe(true);
  await savePreferences({ video: true, transcript: true, automatic: false, reload: false });
  expect((await loadPreferences()).reload).not.toBe(true);
});

it('does not ask again for a folder whose permission is already granted', async () => {
  const { hasDirectoryAccess } = await import('./preferences');
  const handle = { queryPermission: vi.fn(async () => 'granted'), requestPermission: vi.fn() };
  const requested = vi.fn();
  expect(
    await hasDirectoryAccess(handle as unknown as FileSystemDirectoryHandle, true, requested)
  ).toBe(true);
  expect(handle.requestPermission).not.toHaveBeenCalled();
  expect(requested).not.toHaveBeenCalled();
});
it('requests folder access once and reuses the browser grant on subsequent checks', async () => {
  const { hasDirectoryAccess } = await import('./preferences');
  let granted = false;
  const handle = {
    queryPermission: vi.fn(async () => (granted ? 'granted' : 'prompt')),
    requestPermission: vi.fn(async () => {
      granted = true;
      return 'granted';
    }),
  };
  const requested = vi.fn();
  expect(
    await hasDirectoryAccess(handle as unknown as FileSystemDirectoryHandle, true, requested)
  ).toBe(true);
  expect(
    await hasDirectoryAccess(handle as unknown as FileSystemDirectoryHandle, true, requested)
  ).toBe(true);
  expect(handle.requestPermission).toHaveBeenCalledOnce();
  expect(requested).toHaveBeenCalledOnce();
});
