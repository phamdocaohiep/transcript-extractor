import { beforeEach, expect, it, vi } from 'vitest';
import { deleteSaved, revealSaved } from './saved-files';
import { loadFiles, clearFiles, hasDirectoryAccess } from './preferences';
vi.mock('./preferences', () => ({
  loadFiles: vi.fn(),
  clearFiles: vi.fn(),
  hasDirectoryAccess: vi.fn(),
}));
const url = 'https://www.youtube.com/watch?v=example';
const key = `download_completed:${url}`;
let data: Record<string, unknown>;
beforeEach(() => {
  vi.mocked(hasDirectoryAccess).mockResolvedValue(true);
  vi.mocked(clearFiles).mockClear();
  data = {
    [key]: { video: true, transcript: true },
    [`${key}:quality:mp4:720`]: { video: true, transcript: true },
    'download_completed:https://www.youtube.com/watch?v=other': { video: true },
    'download_queue:example': [
      { id: 'example', url, status: 'completed', saved: { video: true } },
      { id: 'other', url: 'https://www.youtube.com/watch?v=other', status: 'completed' },
    ],
  };
  vi.stubGlobal('chrome', {
    downloads: {
      search: vi.fn(async (query: { id: number }) => [{ id: query.id, exists: true }]),
      removeFile: vi.fn(async () => undefined),
      show: vi.fn(),
      showDefaultFolder: vi.fn(),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({ ...data })),
        set: vi.fn(async value => {
          Object.assign(data, value);
        }),
      },
    },
  });
});
it('reveals the requested Chrome rendition and falls back to Chrome Downloads for legacy entries', async () => {
  vi.mocked(loadFiles).mockResolvedValue([
    { name: '720.mp4', selection: 'mp4:720', downloadId: 42 },
    { name: '1080.mp4', selection: 'mp4:1080', downloadId: 43 },
  ]);
  await expect(revealSaved(url, { format: 'mp4', maxHeight: 720 })).resolves.toEqual({
    exact: true,
  });
  expect(chrome.downloads.show).toHaveBeenCalledExactlyOnceWith(42);
  vi.mocked(loadFiles).mockResolvedValue([]);
  await expect(revealSaved(url)).resolves.toEqual({ exact: false });
  expect(chrome.downloads.showDefaultFolder).toHaveBeenCalled();
});
it('deletes Chrome-managed files through their IDs without requesting directory permissions', async () => {
  vi.mocked(hasDirectoryAccess).mockClear();
  vi.mocked(loadFiles).mockResolvedValue([
    { name: 'video.mp4', downloadId: 42 },
    { name: 'video.md', downloadId: 43 },
  ]);
  await deleteSaved(url);
  expect(chrome.downloads.removeFile).toHaveBeenNthCalledWith(1, 42);
  expect(chrome.downloads.removeFile).toHaveBeenNthCalledWith(2, 43);
  expect(hasDirectoryAccess).not.toHaveBeenCalled();
  expect(data[key]).toEqual({ video: false, transcript: false });
});
it('does not reset completion when Chrome cannot delete an existing file', async () => {
  vi.mocked(loadFiles).mockResolvedValue([{ name: 'video.mp4', downloadId: 42 }]);
  (chrome.downloads.removeFile as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error('Blocked')
  );
  await expect(deleteSaved(url)).rejects.toThrow('Blocked');
  expect(data[key]).toEqual({ video: true, transcript: true });
  expect(clearFiles).not.toHaveBeenCalled();
});
it('removes every recorded rendition and transcript in their actual directories, preserving unrelated files and queues', async () => {
  const first = { removeEntry: vi.fn() };
  const second = { removeEntry: vi.fn() };
  vi.mocked(loadFiles).mockResolvedValue([
    { directory: first as unknown as FileSystemDirectoryHandle, name: 'video.mp4' },
    { directory: first as unknown as FileSystemDirectoryHandle, name: 'video.md' },
    { directory: second as unknown as FileSystemDirectoryHandle, name: 'video-1080.webm' },
  ]);
  await deleteSaved(url);
  expect(first.removeEntry.mock.calls).toEqual([['video.mp4'], ['video.md']]);
  expect(second.removeEntry).toHaveBeenCalledExactlyOnceWith('video-1080.webm');
  expect(data[key]).toEqual({ video: false, transcript: false });
  expect(data[`${key}:quality:mp4:720`]).toEqual({ video: false, transcript: false });
  expect(data['download_completed:https://www.youtube.com/watch?v=other']).toEqual({ video: true });
  expect(data['download_queue:example']).toEqual([
    expect.objectContaining({ status: 'pending', saved: { video: false, transcript: false } }),
    expect.objectContaining({ id: 'other', status: 'completed' }),
  ]);
  expect(clearFiles).toHaveBeenCalledWith(key);
});
it('handles an already removed file but keeps records on other filesystem errors', async () => {
  const removeEntry = vi.fn().mockRejectedValueOnce(new DOMException('Missing', 'NotFoundError'));
  vi.mocked(loadFiles).mockResolvedValue([
    { directory: { removeEntry } as unknown as FileSystemDirectoryHandle, name: 'video.mp4' },
  ]);
  await deleteSaved(url);
  vi.mocked(clearFiles).mockClear();
  removeEntry.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
  await expect(deleteSaved(url)).rejects.toThrow('Denied');
  expect(clearFiles).not.toHaveBeenCalled();
});
it('resets older downloads without guessing filenames and rejects folder traversal', async () => {
  vi.mocked(loadFiles).mockResolvedValue([]);
  await expect(deleteSaved(url)).resolves.toEqual({ filesRecorded: false });
  expect(data[key]).toEqual({ video: false, transcript: false });
  expect(data[`${key}:quality:mp4:720`]).toEqual({ video: false, transcript: false });
  const removeEntry = vi.fn();
  vi.mocked(loadFiles).mockResolvedValue([
    { directory: { removeEntry } as unknown as FileSystemDirectoryHandle, name: '../other.mp4' },
  ]);
  await expect(deleteSaved(url)).rejects.toThrow('invalid');
  expect(removeEntry).not.toHaveBeenCalled();
});
