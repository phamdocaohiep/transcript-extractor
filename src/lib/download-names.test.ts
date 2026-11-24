import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installNames, outputNameKey } from './download-names';

let listener: (
  item: chrome.downloads.DownloadItem,
  suggest: (value?: chrome.downloads.FilenameSuggestion) => void
) => boolean | void;
const url = 'blob:chrome-extension://test-id/output-id';
beforeEach(() => {
  vi.stubGlobal('chrome', {
    runtime: { id: 'test-id' },
    storage: {
      session: { get: vi.fn(async () => ({ [outputNameKey(url)]: 'Chủ đề dữ liệu.mp4' })) },
    },
    downloads: {
      onDeterminingFilename: {
        addListener: vi.fn(value => {
          listener = value;
        }),
      },
    },
  });
  installNames();
});
afterEach(() => vi.unstubAllGlobals());
it('replaces the blob ID with its registered subject name after a worker restart', async () => {
  const suggest = vi.fn();
  expect(
    listener({ url, byExtensionId: 'test-id' } as chrome.downloads.DownloadItem, suggest)
  ).toBe(true);
  await vi.waitFor(() =>
    expect(suggest).toHaveBeenCalledExactlyOnceWith({
      filename: 'Chủ đề dữ liệu.mp4',
      conflictAction: 'uniquify',
    })
  );
});
it.each([
  { url, byExtensionId: 'other' },
  { url: 'https://example.test/video.mp4', byExtensionId: 'test-id' },
])('does not rename unrelated downloads %j', item => {
  const suggest = vi.fn();
  listener(item as chrome.downloads.DownloadItem, suggest);
  expect(suggest).toHaveBeenCalledExactlyOnceWith();
  expect(chrome.storage.session.get).not.toHaveBeenCalled();
});
it.each(['../escape.mp4', '/absolute.mp4', '', 'bad\nname.mp4'])(
  'ignores unsafe registered names %j',
  async name => {
    (chrome.storage.session.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      [outputNameKey(url)]: name,
    });
    const suggest = vi.fn();
    listener({ url, byExtensionId: 'test-id' } as chrome.downloads.DownloadItem, suggest);
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledExactlyOnceWith(undefined));
  }
);
it('releases Chrome when the mapping cannot be read', async () => {
  vi.mocked(chrome.storage.session.get).mockRejectedValue(new Error('Unavailable'));
  const suggest = vi.fn();
  listener({ url, byExtensionId: 'test-id' } as chrome.downloads.DownloadItem, suggest);
  await vi.waitFor(() => expect(suggest).toHaveBeenCalledExactlyOnceWith());
});
it('preserves nested output paths when Chrome determines the filename', async () => {
  (chrome.storage.session.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    [outputNameKey(url)]: 'Khóa học/Nhóm bài/Chủ đề.md',
  });
  const suggest = vi.fn();
  listener({ url, byExtensionId: 'test-id' } as chrome.downloads.DownloadItem, suggest);
  await vi.waitFor(() =>
    expect(suggest).toHaveBeenCalledExactlyOnceWith({
      filename: 'Khóa học/Nhóm bài/Chủ đề.md',
      conflictAction: 'uniquify',
    })
  );
});
