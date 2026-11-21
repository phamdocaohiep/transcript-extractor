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
