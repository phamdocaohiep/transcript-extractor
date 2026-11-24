import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createDestination, publishFile } from './download-manager';

let changed: ((delta: chrome.downloads.DownloadDelta) => void) | undefined;
let removed: ReturnType<typeof vi.fn>;
let directory: FileSystemDirectoryHandle;
let signal: AbortController;
beforeEach(() => {
  vi.restoreAllMocks();
  changed = undefined;
  signal = new AbortController();
  removed = vi.fn(async () => undefined);
  directory = {
    getFileHandle: vi.fn(async () => ({ getFile: async () => new Blob(['media']) })),
  } as unknown as FileSystemDirectoryHandle;
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: vi.fn(async () => ({
        getDirectoryHandle: vi.fn(async () => directory),
        removeEntry: removed,
      })),
    },
  });
  vi.stubGlobal('chrome', {
    storage: {
      session: { set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
    },
    downloads: {
      download: vi.fn(async () => 42),
      search: vi.fn(async () => [{ id: 42, state: 'complete' }]),
      cancel: vi.fn(async () => undefined),
      onChanged: {
        addListener: vi.fn(listener => {
          changed = listener;
        }),
        removeListener: vi.fn(),
      },
    },
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:extension-test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('uses only an owned OPFS output directory, without a user folder chooser', async () => {
  const target = await createDestination();
  expect(target.directory).toBe(directory);
  await target.dispose();
  expect(removed).toHaveBeenCalledWith(expect.stringMatching(/^download-output-/), {
    recursive: true,
  });
});
it('publishes through Chrome with no save dialog, preserves filename and waits for completion', async () => {
  expect(await publishFile(directory, 'My video.mp4', signal.signal)).toBe(42);
  expect(chrome.downloads.download).toHaveBeenCalledWith({
    url: 'blob:extension-test',
    filename: 'My video.mp4',
    saveAs: false,
    conflictAction: 'uniquify',
  });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:extension-test');
  expect(chrome.storage.session.set).toHaveBeenCalledWith({
    'output-name:blob:extension-test': 'My video.mp4',
  });
  expect(chrome.storage.session.remove).toHaveBeenCalledWith('output-name:blob:extension-test');
  expect(chrome.downloads.onChanged.removeListener).toHaveBeenCalled();
});
it('keeps staging flat while Chrome receives the course/group/subject path', async () => {
  await publishFile(directory, 'Subject.mp4', signal.signal, 'Course name/Group name/Subject.mp4');
  expect(directory.getFileHandle).toHaveBeenCalledWith('Subject.mp4');
  expect(chrome.downloads.download).toHaveBeenCalledWith(
    expect.objectContaining({ filename: 'Course name/Group name/Subject.mp4' })
  );
  expect(chrome.storage.session.set).toHaveBeenCalledWith({
    'output-name:blob:extension-test': 'Course name/Group name/Subject.mp4',
  });
});
it.each([
  '/Course/Subject.mp4',
  'Course/../Subject.mp4',
  'Course//Subject.mp4',
  'Course/./Subject.mp4',
])('rejects unsafe output paths %s', async path => {
  await expect(publishFile(directory, 'Subject.mp4', signal.signal, path)).rejects.toThrow(
    'Invalid output path'
  );
  expect(chrome.downloads.download).not.toHaveBeenCalled();
});
it('does not report a Chrome transfer as completed before the completion event', async () => {
  (chrome.downloads.search as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: 42, state: 'in_progress' },
  ]);
  let done = false;
  const result = publishFile(directory, 'video.webm', signal.signal).then(id => {
    done = true;
    return id;
  });
  await vi.waitFor(() => expect(changed).toBeTypeOf('function'));
  changed!({ id: 99, state: { current: 'complete' } });
  await Promise.resolve();
  expect(done).toBe(false);
  changed!({ id: 42, state: { current: 'complete' } });
  expect(await result).toBe(42);
});
it('cancels only its own Chrome transfer and cleans up object URLs and listeners', async () => {
  (chrome.downloads.search as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: 42, state: 'in_progress' },
  ]);
  const result = publishFile(directory, 'video.mp4', signal.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(changed).toBeTypeOf('function'));
  signal.abort();
  await rejected;
  expect(chrome.downloads.cancel).toHaveBeenCalledExactlyOnceWith(42);
  expect(URL.revokeObjectURL).toHaveBeenCalled();
  expect(chrome.downloads.onChanged.removeListener).toHaveBeenCalled();
});
it('surfaces interruption and rejects unsafe filenames before starting a download', async () => {
  (chrome.downloads.search as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: 42, state: 'in_progress' },
  ]);
  const result = publishFile(directory, 'video.mp4', signal.signal);
  const rejected = expect(result).rejects.toThrow('FILE_FAILED');
  await vi.waitFor(() => expect(changed).toBeTypeOf('function'));
  changed!({ id: 42, state: { current: 'interrupted' }, error: { current: 'FILE_FAILED' } });
  await rejected;
  await expect(publishFile(directory, '../file', signal.signal)).rejects.toThrow(
    'Invalid output filename'
  );
  expect(chrome.downloads.download).toHaveBeenCalledTimes(1);
});
it('cancels a transfer if Chrome cannot report its state, before releasing temporary output', async () => {
  (chrome.downloads.search as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error('State unavailable')
  );
  await expect(publishFile(directory, 'video.mp4', signal.signal)).rejects.toThrow(
    'State unavailable'
  );
  expect(chrome.downloads.cancel).toHaveBeenCalledExactlyOnceWith(42);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:extension-test');
});
