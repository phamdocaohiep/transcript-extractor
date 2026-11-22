import { beforeEach, expect, it, vi } from 'vitest';
import { connectFolder, revealFile, markerName } from './finder';
import { hasDirectoryAccess } from './preferences';
vi.mock('./preferences', () => ({ hasDirectoryAccess: vi.fn(async () => true) }));
const id = '00112233-4455-6677-8899-aabbccddeeff';
let content: string;
let exists: boolean;
let directory: FileSystemDirectoryHandle;
let send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  content = JSON.stringify({ version: 1, id });
  exists = true;
  send = vi.fn(async () => ({ ok: true, version: 1 }));
  vi.stubGlobal('chrome', { runtime: { sendNativeMessage: send } });
  vi.mocked(hasDirectoryAccess).mockResolvedValue(true);
  directory = {
    name: 'Saved files',
    getFileHandle: vi.fn(async (name, options) => {
      expect(name).toBe(markerName);
      if (!exists && !options?.create) throw new DOMException('Missing', 'NotFoundError');
      return {
        getFile: async () => ({ size: content.length, text: async () => content }),
        createWritable: async () => ({
          write: async (value: string) => {
            content = value;
          },
          close: async () => {
            exists = true;
          },
          abort: vi.fn(),
        }),
      };
    }),
  } as unknown as FileSystemDirectoryHandle;
});
it('reveals the exact filename through the native helper without any selector or path guessing', async () => {
  await revealFile(directory, 'Vietnamese video.mp4');
  expect(send).toHaveBeenCalledExactlyOnceWith('com.transcript_extractor.finder', {
    action: 'reveal',
    id,
    filename: 'Vietnamese video.mp4',
  });
});
it('opens the connected folder when an older download has no exact filename', async () => {
  await revealFile(directory);
  expect(send).toHaveBeenCalledWith('com.transcript_extractor.finder', { action: 'reveal', id });
});
it('performs setup once, keeping a valid connection marker across reconnection', async () => {
  await connectFolder(directory);
  expect(send.mock.calls.map(call => call[1].action)).toEqual(['ping', 'register']);
  expect(send.mock.calls[1][1].id).toBe(id);
  expect(content).toBe(JSON.stringify({ version: 1, id }));
});
it('creates a marker only after confirming the helper is installed', async () => {
  exists = false;
  await connectFolder(directory);
  const value = JSON.parse(content);
  expect(value.version).toBe(1);
  expect(send.mock.calls[1][1].id).toBe(value.id);
  expect(exists).toBe(true);
});
it('reports missing installation and never writes a marker or opens a picker as fallback', async () => {
  send.mockRejectedValue(new Error('host not found'));
  await expect(connectFolder(directory)).rejects.toThrow('not installed');
  expect(directory.getFileHandle).not.toHaveBeenCalled();
});
it('requires setup and rejects traversing filenames', async () => {
  await expect(revealFile(directory, '../file.mp4')).rejects.toThrow('Invalid saved filename');
  expect(send).not.toHaveBeenCalled();
  exists = false;
  await expect(revealFile(directory)).rejects.toThrow('Connect this saved folder');
});
it('surfaces native errors rather than claiming Finder opened', async () => {
  send.mockResolvedValue({ ok: false, error: 'The saved file no longer exists.' });
  await expect(revealFile(directory, 'video.mp4')).rejects.toThrow('no longer exists');
});
