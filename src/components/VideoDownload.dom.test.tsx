// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://extension.test/video-download.html?tab=42" }
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VideoDownload } from './VideoDownload';
import { flushDiagnostics, exportDiagnostics } from '../lib/diagnostics';
import {
  loadPreferences,
  savePreferences,
  saveDirectory,
  loadDirectory,
  hasDirectoryAccess,
} from '../lib/preferences';
vi.mock('../lib/preferences', () => ({
  loadPreferences: vi.fn(async () => ({ video: true, transcript: true, automatic: false })),
  savePreferences: vi.fn(async () => undefined),
  loadDirectory: vi.fn(async () => null),
  saveDirectory: vi.fn(async () => undefined),
  hasDirectoryAccess: vi.fn(async () => true),
}));
vi.mock('../lib/adaptive-stream', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/adaptive-stream')>();
  return {
    ...actual,
    saveAdaptive: vi.fn(async (_plan, _fetch, destination: FileSystemWritableFileStream) => {
      await destination.write(new Uint8Array([1, 2, 3]));
    }),
  };
});
vi.mock('../lib/track-file', () => ({
  saveTracks: vi.fn(async (_plan, _fetch, destination: FileSystemWritableFileStream) => {
    await destination.write(new Uint8Array([1, 2, 3]));
  }),
}));
vi.mock('../lib/mp4', () => ({
  saveMp4: (
    writeSource: (write: (bytes: Uint8Array) => Promise<void>) => Promise<void>,
    destination: FileSystemWritableFileStream
  ) => writeSource(bytes => destination.write(bytes as BufferSource)),
}));
vi.mock('../lib/collection-store', () => ({
  loadCourseCollection: vi.fn(async () => [
    {
      id: 'https://www.udemy.com/course/test/learn/lecture/1',
      transcript: 'The lecture transcript.',
    },
  ]),
}));
let root: Root;
let container: HTMLDivElement;
let writes: Record<
  string,
  {
    write: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  }
>;
let folder: { getFileHandle: ReturnType<typeof vi.fn>; removeEntry: ReturnType<typeof vi.fn> };
let protectedVideo = false;
let currentUrl = 'https://www.udemy.com/course/test/learn/lecture/1';
let videoUrl = 'https://cdn.test/index.m3u8';
let stored: Record<string, unknown>;
let textPages: Set<string>;
let hasPlayer = true;
let hasSources = true;
let listing: { id: string; title: string; url: string; kind?: string }[];
beforeEach(() => {
  // jsdom does not implement the native dialog methods.
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value() {
        this.setAttribute('open', '');
      },
    },
    close: {
      configurable: true,
      value() {
        this.removeAttribute('open');
      },
    },
  });
  vi.mocked(loadDirectory).mockResolvedValue(null);
  vi.mocked(hasDirectoryAccess).mockResolvedValue(true);
  stored = {};
  textPages = new Set();
  hasPlayer = true;
  hasSources = true;
  listing = [
    { id: '1', title: 'First lecture', url: 'https://www.udemy.com/course/test/learn/lecture/1' },
  ];
  vi.mocked(loadPreferences).mockResolvedValue({ video: true, transcript: true, automatic: false });
  vi.stubGlobal('navigator', {
    locks: { request: vi.fn(async (_name, _options, callback) => callback({})) },
  });
  protectedVideo = false;
  currentUrl = 'https://www.udemy.com/course/test/learn/lecture/1';
  videoUrl = 'https://cdn.test/index.m3u8';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) =>
          Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]]))
        ),
        set: vi.fn(async (value: Record<string, unknown>) => {
          Object.assign(stored, value);
        }),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { sendMessage: vi.fn(async () => ({ success: true, data: { status: 'active' } })) },
    tabs: {
      reload: vi.fn(async () => undefined),
      update: vi.fn(async (_id: number, options: { url: string }) => {
        currentUrl = options.url;
        return {};
      }),
      sendMessage: vi.fn(async (_id: number, request: { type: string }) => {
        if (request.type === 'GET_DOWNLOAD_ITEMS')
          return { success: true, data: { sections: [{ lectures: listing }] } };
        if (request.type === 'EXTRACT_TRANSCRIPT')
          return { success: true, data: 'Transcript from current page.' };
        return {
          success: true,
          data: {
            protocolVersion: 4,
            url: currentUrl,
            title: 'First lecture',
            sources: hasSources && !textPages.has(currentUrl) ? [videoUrl] : [],
            hasPlayer: hasPlayer && !textPages.has(currentUrl),
            loading: false,
            kind: textPages.has(currentUrl) || !hasPlayer ? 'article' : 'video',
            protected: protectedVideo,
          },
        };
      }),
    },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
  });
  const ts = new Uint8Array(188);
  ts[0] = 0x47;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(url.endsWith('.m3u8') ? '#EXTM3U\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST' : ts)
    )
  );
  writes = {};
  folder = {
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
      return {
        createWritable: async () => {
          const writer = {
            write: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
            abort: vi.fn(async () => undefined),
          };
          writes[name] = writer;
          return writer;
        },
      };
    }),
    removeEntry: vi.fn(async () => undefined),
  };
  vi.stubGlobal(
    'showDirectoryPicker',
    vi.fn(async () => ({
      name: 'Lessons',
      ...folder,
      getDirectoryHandle: vi.fn(async () => folder),
    }))
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await flushDiagnostics();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(screen: 'main' | 'settings' = 'main') {
  await act(async () => root.render(<VideoDownload screen={screen} />));
}
async function click(label: string) {
  if (label === 'Choose destination folder') {
    await render('settings');
    const button = [...container.querySelectorAll('button')].find(
      value => value.textContent === label && !value.closest('[hidden]')
    )!;
    await act(async () => button.click());
    await render('main');
    return;
  }
  const button = [...container.querySelectorAll('button')].find(
    b => b.textContent === label && !b.closest('[hidden]')
  )!;
  expect(button, label).toBeTruthy();
  expect(button.disabled, label).toBe(false);
  await act(async () => button.click());
}
it('detects available HLS qualities and downloads the selected resolution', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (...args) =>
    String(args[0]) === videoUrl
      ? new Response(
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000,RESOLUTION=1920x1080\n1080.m3u8'
        )
      : original(...args)
  );
  await render();
  expect(fetch).not.toHaveBeenCalled();
  await click('Detect available qualities');
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Video quality"]')!;
  expect([...select.options].map(option => option.value)).toEqual([
    'auto:0',
    'mp4:1080',
    'mp4:720',
  ]);
  await act(async () => {
    select.value = 'mp4:720';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Choose destination folder');
  await click('Download');
  expect(
    vi.mocked(fetch).mock.calls.some(([url]) => String(url) === 'https://cdn.test/720.m3u8')
  ).toBe(true);
  expect(
    vi.mocked(fetch).mock.calls.some(([url]) => String(url) === 'https://cdn.test/1080.m3u8')
  ).toBe(false);
  expect(container.textContent).toMatch(/1 video(?: & transcript| \/ no transcript) downloaded/);
});
it('shows a single video directly with selection on its preview and no duplicate list', async () => {
  await render();
  const toolbar = container.querySelector('.te-download-toolbar')!;
  expect(toolbar.querySelector('[aria-label="Video quality"]')).not.toBeNull();
  expect(toolbar.querySelector('.te-download-button')?.textContent).toBe('Download');
  expect(container.querySelectorAll('.te-download-button')).toHaveLength(1);
  expect(container.querySelector('.te-item-details')).toBeNull();
  expect(container.querySelector('.te-download-card-head input[type="checkbox"]')).toBeNull();
  expect(container.querySelector('.te-preview-column .te-preview-status')?.textContent).toBe(
    'Ready'
  );
});
it.each([
  { reload: false, ready: true },
  { reload: true, ready: true },
  { reload: false, ready: false },
])('retries missing format discovery at most three times %j', async ({ reload, ready }) => {
  vi.useFakeTimers();
  vi.mocked(loadPreferences).mockResolvedValue({
    video: true,
    transcript: true,
    automatic: false,
    reload,
  });
  let reads = 0;
  vi.mocked(fetch).mockImplementation(async () => {
    reads++;
    return new Response(
      ready && reads === 3
        ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720\n720.m3u8'
        : '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="a.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="a"\nv.m3u8'
    );
  });
  await render();
  expect(reads).toBe(0);
  await click('Detect available qualities');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(reads).toBe(3);
  expect(chrome.tabs.reload).toHaveBeenCalledTimes(reload ? 1 : 0);
  const options = [...container.querySelectorAll('select[aria-label="Video quality"] option')].map(
    option => option.textContent
  );
  expect(options.includes('MP4 · 720p')).toBe(ready);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(reads).toBe(3);
  expect(chrome.tabs.update).not.toHaveBeenCalled();
});
it('reads fresh YouTube metadata when formats arrive after the initial snapshot', async () => {
  vi.useFakeTimers();
  currentUrl = 'https://www.youtube.com/watch?v=example';
  listing = [{ id: 'example', title: 'Example', url: currentUrl }];
  hasSources = false;
  let ready = false;
  Object.assign(chrome, {
    scripting: {
      executeScript: vi.fn(async () => [
        {
          result: {
            url: currentUrl,
            streams: ready
              ? [
                  {
                    url: 'https://cdn.test/video.mp4',
                    mimeType: 'video/mp4; codecs="avc1, mp4a.40.2"',
                    video: true,
                    audio: true,
                    height: 720,
                    bitrate: 1000,
                  },
                ]
              : [],
          },
        },
      ]),
    },
  });
  await render();
  expect(container.querySelector('option[value="mp4:720"]')).toBeNull();
  ready = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(container.querySelector('option[value="mp4:720"]')).not.toBeNull();
  const reads = vi.mocked(chrome.scripting.executeScript).mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(reads);
  expect(chrome.tabs.reload).not.toHaveBeenCalled();
  expect(chrome.tabs.update).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(chrome.tabs.sendMessage)
      .mock.calls.some(call => (call[1] as { type: string }).type === 'PREPARE_DOWNLOAD')
  ).toBe(false);
});
it('keeps progress, combining details and cancellation inside the source card', async () => {
  const { saveTracks } = await import('../lib/track-file');
  currentUrl = 'https://www.youtube.com/watch?v=example';
  listing = [{ id: 'example', title: 'Example', url: currentUrl }];
  hasSources = false;
  Object.assign(chrome, {
    scripting: {
      executeScript: vi.fn(async () => [
        {
          result: {
            url: currentUrl,
            streams: [
              {
                url: 'https://cdn.test/video.mp4',
                mimeType: 'video/mp4; codecs="avc1, mp4a.40.2"',
                video: true,
                audio: true,
                height: 720,
                bitrate: 1000,
              },
            ],
          },
        },
      ]),
    },
  });
  let finish: (() => void) | undefined;
  vi.mocked(saveTracks).mockImplementationOnce(
    async (_plan, _fetch, destination, _signal, progress, notice) => {
      progress(2, 2, 1048576);
      notice('Combining video and audio into MP4…');
      await new Promise<void>(resolve => {
        finish = resolve;
      });
      await destination.write(new Uint8Array([1, 2, 3]));
    }
  );
  await render();
  await click('Choose destination folder');
  await click('Download');
  const card = container.querySelector('.te-download-card')!;
  expect(card.querySelector('.te-preview-column .te-preview-status')?.textContent).toBe(
    'Downloading'
  );
  expect(card.querySelector('[aria-label^="Edit filename:"]')).toBeNull();
  expect(card.querySelector('.te-status-line [aria-label="Cancel download"]')).not.toBeNull();
  expect(card.querySelector('.te-download-progress button')).toBeNull();
  expect(card.querySelector('progress')?.value).toBe(2);
  expect(card.querySelector('.te-download-progress')?.textContent).toContain('1.0 MB downloaded');
  expect(card.querySelector('.te-download-progress [role="status"]')?.textContent).toContain(
    'Combining video'
  );
  expect([...card.querySelectorAll('button')].some(button => button.textContent === 'Cancel')).toBe(
    true
  );
  expect(container.querySelector('main > [role="status"]')).toBeNull();
  expect(container.querySelector('main > progress')).toBeNull();
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  await act(async () => finish!());
  expect(card.querySelector('.te-preview-status')?.textContent).toBe('Completed');
  expect(card.querySelector('progress')).toBeNull();
});
it('writes directly into the configured folder and browses its saved location without changing settings', async () => {
  const locations = new Map<string, FileSystemDirectoryHandle>();
  vi.mocked(saveDirectory).mockImplementation(async (handle, key = 'directory') => {
    locations.set(key, handle);
  });
  vi.mocked(loadDirectory).mockImplementation(
    async (key = 'directory') => locations.get(key) || null
  );
  const picker = vi.fn(async () => []);
  vi.stubGlobal('showOpenFilePicker', picker);
  await render();
  await click('Choose destination folder');
  const destination = locations.get('directory')!;
  await click('Download');
  expect(destination.getDirectoryHandle).not.toHaveBeenCalled();
  expect(folder.getFileHandle).toHaveBeenCalled();
  const button = container.querySelector<HTMLButtonElement>(
    '[aria-label="Browse saved location"]'
  )!;
  expect(button).not.toBeNull();
  expect(container.querySelector('[aria-label^="Edit filename:"]')).toBeNull();
  await act(async () => button.click());
  expect(picker).toHaveBeenCalledWith({ startIn: destination });
  expect(locations.get('directory')).toBe(destination);
  expect(chrome.tabs.reload).not.toHaveBeenCalled();
  vi.mocked(saveDirectory).mockImplementation(async () => undefined);
});
it('uses the newest global destination when it changes after editing a filename', async () => {
  await render();
  await click('Choose destination folder');
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Edit filename: First lecture"]')!
      .click()
  );
  const input = container.querySelector<HTMLInputElement>('.te-filename-input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'Latest choice'
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const newest = { name: 'New folder', ...folder, getFileHandle: vi.fn(folder.getFileHandle) };
  vi.mocked(
    (window as unknown as { showDirectoryPicker: ReturnType<typeof vi.fn> }).showDirectoryPicker
  ).mockResolvedValueOnce(newest);
  await render('settings');
  await act(async () => container.querySelector<HTMLButtonElement>('.te-folder-setting')!.click());
  await render('main');
  await click('Download');
  expect(newest.getFileHandle).toHaveBeenCalledWith('Latest choice.mp4', { create: true });
  expect(Object.keys(writes).sort()).toEqual(['Latest choice.md', 'Latest choice.mp4']);
});
it('removes a downloaded row without deleting files or forgetting saved progress', async () => {
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(container.querySelector('.te-download-toolbar')).toBeNull();
  expect(container.querySelector('[aria-label="Video quality"]')).toBeNull();
  expect(container.textContent).toContain('1 video & transcript downloaded');
  const remove = container.querySelector<HTMLButtonElement>(
    '[aria-label="Remove downloaded item: First lecture"]'
  )!;
  expect(remove).not.toBeNull();
  await act(async () => remove.click());
  expect(container.querySelectorAll('li input')).toHaveLength(0);
  expect(folder.removeEntry).not.toHaveBeenCalled();
  expect(stored['download_completed:https://www.udemy.com/course/test/learn/lecture/1']).toEqual({
    video: true,
    transcript: true,
  });
});
it('does not reload a stale source by default', async () => {
  (chrome.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    success: false,
    error: 'Unknown message type',
  });
  await render();
  expect(chrome.tabs.reload).not.toHaveBeenCalled();
  expect(container.textContent).toContain('older extension script');
  expect(container.querySelector('.te-preview-status')?.textContent).toBe('Failed');
  expect(container.querySelectorAll('button.te-retry-button')).toHaveLength(1);
  expect(container.querySelector('.te-download-toolbar')).toBeNull();
  await click('Retry');
  expect(chrome.tabs.reload).not.toHaveBeenCalled();
  expect(container.querySelector('.te-download-title')?.textContent).toBe('First lecture');
  expect(folder.getFileHandle).not.toHaveBeenCalled();
});
it('resets a failed single item without reloading or downloading after Retry', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  let fail = true;
  vi.mocked(fetch).mockImplementation(async (...args) => {
    if (fail) {
      fail = false;
      return new Response('Unavailable', { status: 500 });
    }
    return original(...args);
  });
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(chrome.tabs.reload).not.toHaveBeenCalled();
  expect(container.querySelectorAll('button.te-retry-button')).toHaveLength(1);
  expect(container.querySelector('.te-item-status .te-retry-button')).not.toBeNull();
  expect(container.querySelector('.te-download-toolbar')).toBeNull();
  expect(container.textContent).not.toContain('Retry video list');
  expect(container.textContent).not.toContain('The full list is not loaded');
  expect(container.textContent).not.toContain('Finished: 0 saved');
  await click('Retry');
  expect(chrome.tabs.reload).not.toHaveBeenCalled();
  expect(container.querySelector('.te-preview-status')?.textContent).toBe('Ready');
  expect(Object.keys(writes)).toHaveLength(0);
  await click('Download');
  expect(container.textContent).toContain('1 video & transcript downloaded');
});
it('reloads on Retry only when configured and still waits for Download', async () => {
  vi.mocked(loadPreferences).mockResolvedValue({
    video: true,
    transcript: true,
    automatic: false,
    reload: true,
  });
  protectedVideo = true;
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(container.querySelector('.te-preview-status')?.textContent).toBe('Failed');
  expect(chrome.tabs.reload).not.toHaveBeenCalled();
  protectedVideo = false;
  await click('Retry');
  expect(chrome.tabs.reload).toHaveBeenCalledExactlyOnceWith(42);
  expect(container.querySelector('.te-preview-status')?.textContent).toBe('Ready');
  expect(Object.keys(writes)).toHaveLength(0);
  await click('Download');
  expect(container.textContent).toContain('1 video & transcript downloaded');
});
it('keeps Retry at Ready even when automatic downloading is enabled', async () => {
  vi.useFakeTimers();
  vi.mocked(loadPreferences).mockResolvedValue({ video: true, transcript: true, automatic: true });
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockResolvedValueOnce(new Response('Unavailable', { status: 500 }));
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(container.querySelector('.te-preview-status')?.textContent).toBe('Failed');
  await click('Retry');
  expect(container.querySelector('.te-preview-status')?.textContent).toBe('Ready');
  const requests = vi.mocked(fetch).mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(fetch).toHaveBeenCalledTimes(requests);
  expect(Object.keys(writes)).toHaveLength(0);
  vi.mocked(fetch).mockImplementation(original);
  await click('Download');
  expect(container.textContent).toContain('1 video & transcript downloaded');
});
it('takes a fresh source snapshot before reading its videos after navigation', async () => {
  let reads = 0;
  const original = vi.mocked(chrome.tabs.sendMessage).getMockImplementation()!;
  vi.mocked(chrome.tabs.sendMessage).mockImplementation(async (...args) => {
    if ((args[1] as { type: string }).type === 'GET_HLS_DOWNLOAD_CONTEXT' && ++reads === 2) {
      currentUrl = 'https://www.udemy.com/course/next/learn/lecture/2';
      listing = [{ id: '2', title: 'Next video', url: currentUrl }];
    }
    return original(...args);
  });
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(container.textContent).toContain('1 video & transcript downloaded');
  expect(container.textContent).not.toContain('outside this collection');
});
it('shows a lower list only for multiple videos, with each checkbox on its preview', async () => {
  listing = [1, 2].map(id => ({
    id: String(id),
    title: `Item ${id}`,
    url: `https://www.udemy.com/course/test/learn/lecture/${id}`,
  }));
  await render();
  const details = container.querySelector<HTMLDetailsElement>('.te-item-details')!;
  expect(details.open).toBe(false);
  expect(details.querySelector('summary')?.textContent).toBe('Videos (2)');
  expect(details.querySelectorAll('.te-preview-selection input')).toHaveLength(2);
  expect(details.querySelectorAll('.te-item-title')).toHaveLength(2);
  const all = container.querySelector<HTMLInputElement>('[aria-label="Select all (2)"]')!;
  await act(async () => all.click());
  expect(
    [...details.querySelectorAll<HTMLInputElement>('input')].every(input => !input.checked)
  ).toBe(true);
});
it('allows another quality to download while reusing the previously saved transcript', async () => {
  vi.mocked(loadPreferences).mockResolvedValue({
    video: true,
    transcript: true,
    automatic: false,
    maxHeight: 720,
  });
  const base = 'download_completed:https://www.udemy.com/course/test/learn/lecture/1';
  stored[base] = { video: true, transcript: true };
  await render();
  expect(container.textContent).toContain('1 transcript downloaded');
  expect(container.textContent).toMatch(/1 (?:video & )?transcript downloaded/);
  await click('Choose destination folder');
  await click('Download');
  expect(Object.keys(writes)).toHaveLength(1);
  expect(Object.keys(writes)[0]).toMatch(/\.mp4$/);
  expect(stored[`${base}:quality:auto:720`]).toEqual({ video: true, transcript: true });
  expect(stored[base]).toEqual({ video: true, transcript: true });
});
it('saves the video and transcript as a matching pair in the selected course folder', async () => {
  await render();
  await click('Choose destination folder');
  await click('Download');
  const names = Object.keys(writes);
  expect(names).toHaveLength(2);
  expect(names[0].replace('.md', '')).toBe(names[1].replace('.mp4', ''));
  expect(writes[names[0]].write).toHaveBeenCalledWith(
    expect.stringContaining('The lecture transcript.')
  );
  expect(writes[names[1]].write).toHaveBeenCalledWith(expect.any(Uint8Array));
  expect(writes[names[1]].close).toHaveBeenCalledOnce();
  expect(Object.values(writes).every(writer => writer.close.mock.calls.length === 1)).toBe(true);
});
it('streams a direct MP4 with the existing Chrome session', async () => {
  videoUrl = 'https://cdn.test/video.mp4';
  const file = new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109, 1]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(file))
  );
  await render();
  await click('Choose destination folder');
  await click('Download');
  const name = Object.keys(writes).find(item => item.endsWith('.mp4'))!;
  expect(writes[name].write).toHaveBeenCalledWith(file);
  expect(writes[name].close).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(videoUrl, expect.objectContaining({ credentials: 'include' }));
});
it('reloads an older content script only when the option is enabled', async () => {
  vi.mocked(loadPreferences).mockResolvedValue({
    video: true,
    transcript: true,
    automatic: false,
    reload: true,
  });
  const send = chrome.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>;
  send.mockResolvedValueOnce({ success: false, error: 'Unknown message type' });
  await render();
  expect(chrome.tabs.reload).toHaveBeenCalledWith(42);
  expect(container.textContent).toContain('First lecture');
  expect(container.textContent).not.toContain('older extension script');
});
it('removes an incomplete video and retains its transcript when the video server fails', async () => {
  await render();
  await click('Choose destination folder');
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (...args) =>
    String(args[0]).endsWith('.m3u8') ? original(...args) : new Response('Expired', { status: 403 })
  );
  await click('Download');
  const names = Object.keys(writes);
  expect(writes[names[0]].close).toHaveBeenCalledOnce();
  expect(writes[names[1]].abort).toHaveBeenCalledOnce();
  expect(folder.removeEntry).toHaveBeenCalledWith(names[1]);
  expect(container.textContent).toContain('Video was not completed');
  expect(container.textContent).toContain('HTTP 403');
});
it('downloads the current item when the source tab has navigated to another lecture', async () => {
  await render();
  await click('Choose destination folder');
  currentUrl = 'https://www.udemy.com/course/test/learn/lecture/2';
  await click('Download');
  expect(folder.getFileHandle).toHaveBeenCalled();
  expect(container.textContent).toContain('1 video & transcript downloaded');
});
it('requests host permission only after an explicit click', async () => {
  vi.mocked(chrome.permissions.contains).mockImplementation(async () => false);
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(fetch).not.toHaveBeenCalled();
  expect(chrome.permissions.request).not.toHaveBeenCalled();
  await click('Allow listed video hosts');
  expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://cdn.test/*'] });
});
it('refuses a player using DRM without fetching its manifest', async () => {
  protectedVideo = true;
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(container.textContent).toContain('This player uses DRM');
  expect(fetch).not.toHaveBeenCalled();
});

it('reuses one CDN family grant throughout the queue and displays the wildcard correctly', async () => {
  let granted = false;
  videoUrl = 'https://r1.googlevideo.com/index.m3u8';
  listing.push({
    id: '2',
    title: 'Second lecture',
    url: 'https://www.udemy.com/course/test/learn/lecture/2',
  });
  vi.mocked(chrome.permissions.contains).mockImplementation(
    async query => granted && query.origins?.[0] === 'https://*.googlevideo.com/*'
  );
  vi.mocked(chrome.permissions.request).mockImplementation(async () => {
    granted = true;
    videoUrl = 'https://r2.googlevideo.com/index.m3u8';
    return true;
  });
  await render();
  await click('Choose destination folder');
  await click('Download');
  const dialog = container.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain('*.googlevideo.com');
  expect(dialog.textContent).not.toContain('%2A');
  await click('Allow listed video hosts');
  expect(chrome.permissions.request).toHaveBeenCalledExactlyOnceWith({
    origins: ['https://*.googlevideo.com/*'],
  });
  expect(dialog.open).toBe(false);
  expect(container.textContent).toContain('2/2 videos saved');
});

it('downloads video without extracting or requiring transcript when only video is selected', async () => {
  vi.mocked(loadPreferences).mockResolvedValue({
    video: true,
    transcript: false,
    automatic: false,
  });
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(Object.keys(writes)).toHaveLength(1);
  expect(Object.keys(writes)[0]).toMatch(/\.mp4$/);
  expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(
    42,
    expect.objectContaining({ type: 'EXTRACT_TRANSCRIPT' }),
    expect.anything()
  );
});
it('downloads transcript without fetching video when only transcript is selected', async () => {
  vi.mocked(loadPreferences).mockResolvedValue({
    video: false,
    transcript: true,
    automatic: false,
  });
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(Object.keys(writes)).toHaveLength(1);
  expect(Object.keys(writes)[0]).toMatch(/\.md$/);
  expect(fetch).not.toHaveBeenCalled();
});
it('denies a download before creating files when the mock device limit is reached', async () => {
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
    success: true,
    data: { status: 'device_limit' },
  } as never);
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(folder.getFileHandle).not.toHaveBeenCalled();
  expect(container.textContent).toContain('device_limit');
});
it('saves a changed download choice into the profile', async () => {
  await render('settings');
  const input = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  await act(async () => input.click());
  expect(savePreferences).toHaveBeenCalledWith({
    video: false,
    transcript: true,
    automatic: false,
  });
});

it('downloads all selected items in order and restores completed progress after reopening', async () => {
  listing = [1, 2].map(id => ({
    id: String(id),
    title: `Item ${id}`,
    url: `https://www.udemy.com/course/test/learn/lecture/${id}`,
  }));
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(container.textContent).toContain('2/2 videos saved');
  expect(Object.keys(writes)).toHaveLength(4);
  expect(chrome.tabs.update).toHaveBeenCalledWith(42, { url: listing[1].url });
  await act(async () => {
    root.unmount();
  });
  root = createRoot(container);
  await render();
  expect(container.textContent).toContain('2/2 videos saved');
  const resume = [...container.querySelectorAll('button')].find(
    button => button.textContent === 'Download'
  );
  expect(resume?.disabled).toBe(true);
});
it('automatically downloads a ready item once and remembers that completion', async () => {
  vi.useFakeTimers();
  vi.mocked(loadPreferences).mockResolvedValue({ video: true, transcript: false, automatic: true });
  await render();
  await click('Choose destination folder');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(Object.keys(writes)).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4100);
  });
  expect(Object.keys(writes)).toHaveLength(1);
  expect(Object.keys(stored).some(key => key.startsWith('download_completed:'))).toBe(true);
});
it('honors an unchecked item in the collection list', async () => {
  listing = [1, 2].map(id => ({
    id: String(id),
    title: `Item ${id}`,
    url: `https://www.udemy.com/course/test/learn/lecture/${id}`,
  }));
  await render();
  const checkbox = container.querySelector<HTMLInputElement>('[aria-label="Select Item 2"]')!;
  await act(async () => checkbox.click());
  await click('Choose destination folder');
  await click('Download');
  expect(Object.keys(writes)).toHaveLength(2);
  expect(chrome.tabs.update).not.toHaveBeenCalled();
  expect(container.textContent).toContain('1/2 videos saved');
});
it('resumes a failed queue without repeating a completed video', async () => {
  vi.mocked(loadPreferences).mockResolvedValue({
    video: true,
    transcript: true,
    automatic: false,
    reload: true,
  });
  listing = [1, 2].map(id => ({
    id: String(id),
    title: `Item ${id}`,
    url: `https://www.udemy.com/course/test/learn/lecture/${id}`,
  }));
  const original = vi.mocked(fetch).getMockImplementation()!;
  let mediaCalls = 0;
  vi.mocked(fetch).mockImplementation(async (...args) => {
    if (!String(args[0]).endsWith('.m3u8') && ++mediaCalls === 2)
      return new Response('Expired', { status: 403 });
    return original(...args);
  });
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(chrome.tabs.reload).toHaveBeenCalledWith(42);
  expect(container.textContent).toContain('2/2 videos saved');
  expect(mediaCalls).toBe(3);
  expect(
    Object.keys(writes).filter(
      name => name.endsWith('.mp4') && writes[name].close.mock.calls.length
    )
  ).toHaveLength(2);
});
it('loads the collection list when opened through the popup whole-course action', async () => {
  listing = [1, 2].map(id => ({
    id: String(id),
    title: `Item ${id}`,
    url: `https://www.udemy.com/course/test/learn/lecture/${id}`,
  }));
  window.history.replaceState({}, '', '/video-download.html?tab=42&scope=all');
  try {
    await render();
    expect(container.textContent).toContain('Item 1');
    expect(container.textContent).toContain('Item 2');
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      42,
      { type: 'GET_DOWNLOAD_ITEMS', data: undefined },
      { frameId: 0 }
    );
  } finally {
    window.history.replaceState({}, '', '/video-download.html?tab=42');
  }
});

it('keeps settings and backend polling details off the Main view', async () => {
  await render();
  const settings = [...container.querySelectorAll('section')].find(section =>
    section.textContent?.includes('Download settings')
  )!;
  expect(settings.hidden).toBe(true);
  expect(container.textContent).not.toContain('15 minutes');
  expect(container.textContent).not.toContain('API simulator');
  await render('settings');
  expect(settings.hidden).toBe(false);
  const mainAction = [...container.querySelectorAll('button')].find(
    button => button.textContent === 'Download'
  )!;
  expect(mainAction.closest('[hidden]')).toBeTruthy();
});
it('skips a page without a player and saves its available transcript', async () => {
  vi.useFakeTimers();
  hasPlayer = false;
  hasSources = false;
  await render();
  await click('Choose destination folder');
  await click('Download');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(Object.keys(writes)).toHaveLength(1);
  expect(Object.keys(writes)[0]).toMatch(/\.md$/);
  expect(container.textContent).toContain('No video player');
});

it('does not start playback or reload a missing stream by default', async () => {
  vi.useFakeTimers();
  hasSources = false;
  await render();
  await click('Choose destination folder');
  await click('Download');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(11000);
  });
  expect(Object.keys(writes)).toHaveLength(0);
  expect(chrome.tabs.reload).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(chrome.tabs.sendMessage)
      .mock.calls.some(call => (call[1] as { type: string }).type === 'PREPARE_DOWNLOAD')
  ).toBe(false);
  expect(container.textContent).toContain('Play the video manually');
});
it('waits silently for a stream in automatic mode and downloads when it becomes available', async () => {
  vi.useFakeTimers();
  hasSources = false;
  vi.mocked(loadPreferences).mockResolvedValue({ video: true, transcript: false, automatic: true });
  await render();
  await click('Choose destination folder');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4500);
  });
  expect(Object.keys(writes)).toHaveLength(0);
  hasSources = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });
  expect(Object.keys(writes)).toHaveLength(1);
  expect(chrome.tabs.reload).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(chrome.tabs.sendMessage)
      .mock.calls.some(call => (call[1] as { type: string }).type === 'PREPARE_DOWNLOAD')
  ).toBe(false);
});
it('continues the whole-course queue after a text-only page', async () => {
  vi.useFakeTimers();
  vi.mocked(loadPreferences).mockResolvedValue({
    video: true,
    transcript: false,
    automatic: false,
  });
  listing = [1, 2].map(id => ({
    id: String(id),
    title: `Item ${id}`,
    url: `https://www.udemy.com/course/test/learn/lecture/${id}`,
  }));
  textPages.add(listing[0].url);
  await render();
  await click('Choose destination folder');
  await click('Download');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3500);
  });
  expect(Object.keys(writes)).toHaveLength(1);
  expect(container.textContent).toContain('1 saved, 1 without video, 0 failed');
});
it.each([true, false])(
  'applies the export timestamp setting to downloaded Markdown: %s',
  async includeTimestamps => {
    stored.transcriptExtractorState = { includeTimestamps };
    const { loadCourseCollection } = await import('../lib/collection-store');
    vi.mocked(loadCourseCollection).mockResolvedValueOnce([
      { id: currentUrl, transcript: '[00:12] Timed sentence.\n[01:03] Second sentence.' },
    ] as Awaited<ReturnType<typeof loadCourseCollection>>);
    await render();
    await click('Choose destination folder');
    await click('Download');
    const writer = writes[Object.keys(writes).find(name => name.endsWith('.md'))!];
    const content = String(writer.write.mock.calls[0][0]);
    expect(content).toContain('Timed sentence.');
    expect(content.includes('[00:12]')).toBe(includeTimestamps);
    expect(content.includes('[01:03]')).toBe(includeTimestamps);
  }
);
it('uses an editable filename and preserves it across Settings without changing the original title', async () => {
  await render();
  const edit = container.querySelector<HTMLButtonElement>(
    '[aria-label="Edit filename: First lecture"]'
  )!;
  await act(async () => edit.click());
  const input = container.querySelector<HTMLInputElement>('.te-filename-input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'My video'
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Choose destination folder');
  expect(container.textContent).toContain('First lecture');
  expect(container.querySelector<HTMLInputElement>('.te-filename-input')?.value).toBe('My video');
  await click('Download');
  expect(Object.keys(writes).sort()).toEqual(['My video.md', 'My video.mp4']);
});
it('updates automatic completion after navigating to a new source and returning from Settings', async () => {
  vi.useFakeTimers();
  vi.mocked(loadPreferences).mockResolvedValue({ video: true, transcript: true, automatic: true });
  await render();
  await click('Choose destination folder');
  currentUrl = 'https://www.udemy.com/course/second/learn/lecture/2';
  listing = [{ id: '2', title: 'Second video', url: currentUrl }];
  await render('settings');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  await render('main');
  expect(container.querySelector('.te-preview-status')?.textContent).toBe('Completed');
  expect(container.textContent).toContain('1 video & transcript downloaded');
  expect(container.querySelector('progress')).toBeNull();
  expect(container.textContent).not.toContain('MB downloaded');
  await render('settings');
  await render('main');
  expect(container.querySelector('.te-preview-status')?.textContent).toBe('Completed');
});
it('keeps a download alive while switching between Main and Settings', async () => {
  let release!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve;
      })
  );
  await render();
  await click('Choose destination folder');
  await click('Download');
  await render('settings');
  expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(
    true
  );
  await act(async () => {
    release(new Response('#EXTM3U\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST'));
  });
  await render('main');
  expect(container.textContent).toContain('1 video & transcript downloaded');
  expect(Object.keys(writes)).toHaveLength(2);
  expect(Object.values(writes).every(writer => writer.close.mock.calls.length === 1)).toBe(true);
});

it('offers one primary download action for the chosen scope', async () => {
  await render();
  expect(container.querySelectorAll('section .te-download-button')).toHaveLength(1);
  listing = [1].map(id => ({
    id: String(id),
    title: `Item ${id}`,
    url: `https://www.udemy.com/course/test/learn/lecture/${id}`,
  }));
  expect(container.querySelectorAll('section .te-download-button')).toHaveLength(1);
  expect(container.querySelector('.te-download-button')?.textContent).toContain('Download');
});

it('shows a configuration error when Download is clicked without a saved folder', async () => {
  await render();
  expect(
    [...container.querySelectorAll('button')].some(
      button => !button.closest('[hidden]') && /folder|access/i.test(button.textContent || '')
    )
  ).toBe(false);
  await click('Download');
  expect(container.textContent).toContain('No download folder configured');
  expect(folder.getFileHandle).not.toHaveBeenCalled();
});
it('requests write permission from Download and continues immediately when allowed', async () => {
  vi.mocked(loadDirectory).mockResolvedValue({
    name: 'Lessons',
    ...folder,
    getDirectoryHandle: vi.fn(async () => folder),
  } as unknown as FileSystemDirectoryHandle);
  vi.mocked(hasDirectoryAccess).mockImplementation(async (_folder, request) => Boolean(request));
  await render();
  expect(
    [...container.querySelectorAll('button')].some(button =>
      button.textContent?.includes('Allow access')
    )
  ).toBe(false);
  await click('Download');
  expect(hasDirectoryAccess).toHaveBeenCalledWith(expect.anything(), true, expect.any(Function));
  expect(Object.keys(writes)).toHaveLength(2);
});
it('loads all course items automatically and selects every item initially', async () => {
  listing = [1, 2, 3].map(id => ({
    id: String(id),
    title: `Item ${id}`,
    url: `https://www.udemy.com/course/test/learn/lecture/${id}`,
  }));
  await render();
  const choices = [
    ...container.querySelectorAll('li input[type="checkbox"]'),
  ] as HTMLInputElement[];
  expect(choices).toHaveLength(3);
  expect(choices.every(input => input.checked)).toBe(true);
  expect(container.querySelector('select[aria-label="Download scope"]')).toBeNull();
});
it('keeps Download available after permission is declined so the user can retry', async () => {
  vi.mocked(loadDirectory).mockResolvedValue({
    name: 'Lessons',
    ...folder,
    getDirectoryHandle: vi.fn(async () => folder),
  } as unknown as FileSystemDirectoryHandle);
  let prompts = 0;
  vi.mocked(hasDirectoryAccess).mockImplementation(async (_directory, request) =>
    request ? ++prompts > 1 : false
  );
  await render();
  await click('Download');
  expect(container.textContent).toContain('Folder access was not granted');
  expect(folder.getFileHandle).not.toHaveBeenCalled();
  await click('Download');
  expect(prompts).toBe(2);
  expect(Object.keys(writes)).toHaveLength(2);
});

it('shows the course title and chapter headings and selects videos rather than quizzes', async () => {
  const send = vi.mocked(chrome.tabs.sendMessage).getMockImplementation()!;
  vi.mocked(chrome.tabs.sendMessage).mockImplementation(
    async (...args: Parameters<typeof send>) => {
      if ((args[1] as { type: string }).type === 'GET_DOWNLOAD_ITEMS')
        return {
          success: true,
          data: {
            title: 'Mind map for Beginners',
            sections: [
              {
                title: 'Introduction',
                lectures: [
                  { id: '1', title: 'First video', kind: 'video', url: currentUrl },
                  { id: '99', title: 'Quiz item', kind: 'quiz' },
                ],
              },
              { title: 'Practice', lectures: [{ id: '2', title: 'Second video', kind: 'video' }] },
            ],
          },
        };
      return send(...args);
    }
  );
  await act(async () => {
    root.render(<VideoDownload sourceTabId={42} />);
  });
  expect(container.querySelector('section:not([hidden]) h2')?.textContent).toBe(
    'Mind map for Beginners'
  );
  expect([...container.querySelectorAll('h3')].map(element => element.textContent)).toEqual([
    'Introduction',
    'Practice',
  ]);
  expect(container.textContent).not.toContain('Quiz item');
  expect(container.querySelector('[aria-label="Select all (2)"]')).not.toBeNull();
});

it('allows one current video without showing a list-retry block', async () => {
  listing = [];
  await render();
  expect(container.textContent).not.toContain('Retry video list');
  expect(container.textContent).not.toContain('The full list is not loaded');
  expect(container.querySelectorAll('.te-preview-selection input')).toHaveLength(0);
  await click('Choose destination folder');
  await click('Download');
  expect(container.textContent).toMatch(/1 video(?: & transcript| \/ no transcript) downloaded/);
});
it('offers a list retry without inventing a video when neither curriculum nor player is ready', async () => {
  listing = [];
  hasPlayer = false;
  hasSources = false;
  await render();
  expect(container.textContent).toContain('The video list is not ready');
  expect(container.querySelector('button.te-retry-button')?.textContent).toBe('Retry');
  expect(container.querySelectorAll('li input')).toHaveLength(0);
});
it('restores saved progress for the current video while waiting for the full curriculum', async () => {
  listing = [];
  stored['download_completed:https://www.udemy.com/course/test/learn/lecture/1'] = {
    video: true,
    transcript: true,
  };
  await render();
  expect(container.textContent).toMatch(/1 video(?: & transcript| \/ no transcript) downloaded/);
  expect(container.textContent).toMatch(/1 (?:video & )?transcript downloaded/);
});

it('saves video and continues the queue even when transcript extraction fails', async () => {
  const { loadCourseCollection } = await import('../lib/collection-store');
  vi.mocked(loadCourseCollection).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  listing = [1, 2].map(id => ({
    id: String(id),
    title: `Item ${id}`,
    url: `https://www.udemy.com/course/test/learn/lecture/${id}`,
  }));
  const original = vi.mocked(chrome.tabs.sendMessage).getMockImplementation()!;
  vi.mocked(chrome.tabs.sendMessage).mockImplementation(async (...args) => {
    if ((args[1] as { type: string }).type === 'EXTRACT_TRANSCRIPT')
      return { success: false, error: 'Could not find the transcript panel.' };
    return original(...args);
  });
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(Object.keys(writes).filter(name => name.endsWith('.mp4'))).toHaveLength(2);
  expect(Object.keys(writes).some(name => name.endsWith('.md'))).toBe(false);
  expect(container.textContent).toContain('2 video saved without transcript');
  const completion = Object.entries(stored).filter(([key]) =>
    key.startsWith('download_completed:')
  );
  expect(completion).toHaveLength(2);
  expect(
    completion.every(
      ([, value]) =>
        (value as { video: boolean; transcript: boolean }).video &&
        !(value as { transcript: boolean }).transcript
    )
  ).toBe(true);
});

it('waits for Chrome to finish navigation before preparing the next item', async () => {
  vi.useFakeTimers();
  listing = [
    { id: '2', title: 'Next video', url: 'https://www.udemy.com/course/test/learn/lecture/2' },
  ];
  let loading = true;
  Object.assign(chrome.tabs, {
    get: vi.fn(async () => ({ status: loading ? 'loading' : 'complete' })),
  });
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(Object.keys(writes)).toHaveLength(0);
  loading = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(Object.keys(writes)).toHaveLength(2);
});

it('lets videos skipped by the older player check be downloaded again', async () => {
  stored['download_queue:https://www.udemy.com/course/test:true:true'] = [
    { id: '1', title: 'First lecture', status: 'skipped', selected: true },
  ];
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(Object.keys(writes)).toHaveLength(2);
});

it('shows the host permission dialog in Settings and resumes after Chrome grants access', async () => {
  let granted = false;
  vi.mocked(chrome.permissions.contains).mockImplementation(async () => granted);
  vi.mocked(chrome.permissions.request).mockImplementation(async () => {
    granted = true;
    return true;
  });
  await render();
  await click('Choose destination folder');
  await click('Download');
  await render('settings');
  const dialog = container.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain('cdn.test');
  expect(chrome.permissions.request).not.toHaveBeenCalled();
  await click('Allow listed video hosts');
  expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://cdn.test/*'] });
  expect(dialog.open).toBe(false);
  expect(Object.keys(writes)).toHaveLength(2);
});

it('shows the permission dialog during automatic downloading while Settings is open', async () => {
  vi.useFakeTimers();
  vi.mocked(loadPreferences).mockResolvedValue({ video: true, transcript: true, automatic: true });
  vi.mocked(loadDirectory).mockResolvedValue({
    name: 'Lessons',
    ...folder,
    getDirectoryHandle: vi.fn(async () => folder),
  } as unknown as FileSystemDirectoryHandle);
  let granted = false;
  vi.mocked(chrome.permissions.contains).mockImplementation(async () => granted);
  vi.mocked(chrome.permissions.request).mockImplementation(async () => {
    granted = true;
    return true;
  });
  await render('settings');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(container.querySelector('dialog')!.open).toBe(true);
  expect(chrome.permissions.request).not.toHaveBeenCalled();
  await click('Allow listed video hosts');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(container.querySelector('dialog')!.open).toBe(false);
  expect(Object.keys(writes)).toHaveLength(2);
});

it('keeps a declined permission request visible so it can be retried', async () => {
  vi.mocked(chrome.permissions.contains).mockImplementation(async () => false);
  vi.mocked(chrome.permissions.request).mockImplementation(async () => false);
  await render();
  await click('Choose destination folder');
  await click('Download');
  await click('Allow listed video hosts');
  const dialog = container.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('not granted');
  expect(Object.keys(writes)).toHaveLength(0);
});

it('discovers the signed-in YouTube player in MAIN world and saves paired tracks through the shared download flow', async () => {
  const { saveTracks } = await import('../lib/track-file');
  currentUrl = 'https://www.youtube.com/watch?v=example';
  listing = [{ id: 'example', title: 'An example', url: currentUrl }];
  hasSources = false;
  const video = {
    url: 'https://r1.googlevideo.com/videoplayback?id=test&itag=137',
    mimeType: 'video/mp4; codecs="avc1.640028"',
    video: true,
    audio: false,
    height: 1080,
    bitrate: 1000,
  };
  const audio = {
    url: 'https://r1.googlevideo.com/videoplayback?id=test&itag=140',
    mimeType: 'audio/mp4; codecs="mp4a.40.2"',
    video: false,
    audio: true,
    height: 0,
    bitrate: 128,
  };
  Object.assign(chrome, {
    scripting: {
      executeScript: vi.fn(async () => [
        { result: { url: currentUrl, title: 'An example', streams: [video, audio] } },
      ]),
    },
  });
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
    expect.objectContaining({
      world: 'MAIN',
      target: { tabId: 42, frameIds: [0] },
      func: expect.any(Function),
    })
  );
  expect(saveTracks).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'tracks', video, audio, extension: 'mp4' }),
    expect.any(Function),
    expect.anything(),
    expect.anything(),
    expect.any(Function),
    expect.any(Function)
  );
  expect(Object.keys(writes).some(name => name.endsWith('.mp4'))).toBe(true);
  expect(container.textContent).toContain('1 video & transcript downloaded');
});

it.each([{}, { format: 'webm' as const }, { maxHeight: 144 }])(
  'downloads a captured session without labels and recovers unavailable quality %j',
  async choice => {
    const { saveAdaptive } = await import('../lib/adaptive-stream');
    const { completionKey } = await import('../lib/download');
    vi.mocked(saveAdaptive).mockClear();
    vi.mocked(savePreferences).mockClear();
    vi.mocked(loadPreferences).mockResolvedValue({
      video: true,
      transcript: true,
      automatic: false,
      ...choice,
    });
    currentUrl = 'https://www.youtube.com/watch?v=example';
    listing = [{ id: 'example', title: 'An example', url: currentUrl }];
    hasSources = false;
    const getDirectoryHandle = vi.fn(async () => folder);
    vi.mocked(loadDirectory).mockResolvedValue({
      name: 'Previous folder',
      ...folder,
      getDirectoryHandle,
    } as unknown as FileSystemDirectoryHandle);
    const adaptive = {
      videoId: 'example',
      url: 'https://r1.googlevideo.com/videoplayback?ump=1',
      config: 'AQI=',
      token: 'private-fixture-token',
      duration: 60,
      clientInfo: { clientName: 1 },
      formats: [
        {
          itag: 137,
          lastModified: '1',
          bitrate: 1000,
          mimeType: 'video/mp4; codecs="avc1.640028"',
          height: 720,
          approxDurationMs: '60000',
        },
        {
          itag: 140,
          lastModified: '1',
          bitrate: 128,
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          approxDurationMs: '60000',
        },
      ],
    };
    Object.assign(chrome, {
      scripting: {
        executeScript: vi.fn(async () => [
          { result: { url: currentUrl, title: 'An example', streams: [], adaptive } },
        ]),
      },
    });
    await render();
    expect(container.textContent).toContain('Folder: Previous folder — change');
    await click('Download');
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
    if (Object.keys(choice).length) {
      expect(saveAdaptive).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Retry will use Auto quality');
      expect(container.textContent).not.toContain('Retry video list');
      await click('Retry');
      expect(chrome.tabs.reload).not.toHaveBeenCalled();
      expect(savePreferences).toHaveBeenCalledWith({
        video: true,
        transcript: true,
        automatic: false,
        format: undefined,
        maxHeight: undefined,
      });
      expect(stored[completionKey(currentUrl, choice)]).toBeUndefined();
      expect(saveAdaptive).not.toHaveBeenCalled();
      expect(container.querySelector('.te-preview-status')?.textContent).toBe('Ready');
      await click('Download');
    }
    expect(saveAdaptive).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'adaptive', session: adaptive }),
      expect.any(Function),
      expect.anything(),
      expect.anything(),
      expect.any(Function),
      expect.any(Function)
    );
    expect(getDirectoryHandle).not.toHaveBeenCalled();
    expect(container.textContent).toContain('1 video & transcript downloaded');
    expect(stored[completionKey(currentUrl)]).toEqual(expect.objectContaining({ video: true }));
    expect(
      vi
        .mocked(chrome.tabs.sendMessage)
        .mock.calls.some(call => (call[1] as { type: string }).type === 'PREPARE_DOWNLOAD')
    ).toBe(false);
    expect(JSON.stringify(stored)).not.toContain('private-fixture-token');
  }
);

it('does not start an automatic retry immediately after a manual download fails', async () => {
  vi.useFakeTimers();
  vi.mocked(loadPreferences).mockResolvedValue({ video: true, transcript: false, automatic: true });
  hasSources = false;
  await render();
  await click('Choose destination folder');
  await click('Download');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(22000);
  });
  expect(container.querySelector('.te-preview-status')?.textContent).toBe('Failed');
  const download = [...container.querySelectorAll('button')].find(
    button => button.textContent === 'Retry'
  )!;
  expect(download.disabled).toBe(false);
  expect(
    [...container.querySelectorAll('button')].some(
      button => button.textContent === 'Cancel' && !button.closest('dialog')
    )
  ).toBe(false);
});

it('shows a compact saved-without-transcript result and preserves it on reopen', async () => {
  const { loadCourseCollection } = await import('../lib/collection-store');
  vi.mocked(loadCourseCollection).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  const original = vi.mocked(chrome.tabs.sendMessage).getMockImplementation()!;
  vi.mocked(chrome.tabs.sendMessage).mockImplementation(async (...args) => {
    if ((args[1] as { type: string }).type === 'EXTRACT_TRANSCRIPT')
      return { success: false, error: 'No captions available.' };
    return original(...args);
  });
  await render();
  await click('Choose destination folder');
  await click('Download');
  expect(container.textContent).toMatch(/1 video(?: & transcript| \/ no transcript) downloaded/);
  expect(container.textContent).toContain('1 video / no transcript downloaded');
  expect(container.textContent).not.toContain('Finished: 1 saved');
  const mediaCount = vi.mocked(fetch).mock.calls.length;
  expect(container.querySelector('.te-download-toolbar')).toBeNull();
  expect(vi.mocked(fetch).mock.calls.length).toBe(mediaCount);
  expect(Object.keys(writes).filter(name => name.endsWith('.mp4'))).toHaveLength(1);
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.textContent).toMatch(/1 video(?: & transcript| \/ no transcript) downloaded/);
  expect(container.textContent).toContain('1 video / no transcript downloaded');
  const log = JSON.parse(await exportDiagnostics());
  expect(
    log.events.filter((entry: { event: string }) => entry.event === 'file_saved')
  ).toHaveLength(1);
});

it.each([2, 3])(
  'downloads loaded selections from a playlist declaring %i entries without a manual player click',
  async totalItems => {
    currentUrl = 'https://www.youtube.com/playlist?list=PL123';
    listing = ['first', 'last'].map(id => ({
      id,
      title: id,
      url: `https://www.youtube.com/watch?v=${id}&list=PL123`,
    }));
    Object.assign(chrome, { scripting: { executeScript: vi.fn(async () => []) } });
    const original = vi.mocked(chrome.tabs.sendMessage).getMockImplementation()!;
    vi.mocked(chrome.tabs.sendMessage).mockImplementation(async (...args) => {
      const reply = (await original(...args)) as unknown as {
        success: boolean;
        data: Record<string, unknown>;
      };
      const type = (args[1] as { type: string }).type;
      if (type === 'GET_DOWNLOAD_ITEMS')
        return {
          ...reply,
          data: { ...reply.data, title: 'Full series', totalItems, loadedItems: 2 },
        };
      if (type === 'GET_HLS_DOWNLOAD_CONTEXT' && currentUrl.includes('/playlist?'))
        return { ...reply, data: { ...reply.data, sources: [], hasPlayer: false } };
      return reply;
    });
    await render();
    if (totalItems > 2) {
      expect(container.textContent).toContain('2/3 playlist entries loaded');
      expect(container.textContent).toContain('You can download the selected items now');
      expect(container.textContent).toContain('Load remaining items');
    }
    await click('Choose destination folder');
    await click('Download');
    expect(chrome.tabs.update).toHaveBeenCalledWith(42, { url: listing[0].url });
    expect(chrome.tabs.update).toHaveBeenCalledWith(42, { url: listing[1].url });
    expect(container.textContent).toContain('2/2 videos saved');
  }
);

it('restores already-saved artifacts even when the selected formats use a different queue key', async () => {
  vi.mocked(loadPreferences).mockResolvedValue({
    video: true,
    transcript: false,
    automatic: false,
  });
  stored['download_completed:https://www.udemy.com/course/test/learn/lecture/1'] = {
    video: true,
    transcript: false,
  };
  await render();
  expect(container.textContent).toMatch(/1 video(?: & transcript| \/ no transcript) downloaded/);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  const button = [...container.querySelectorAll('button')].find(
    value => value.textContent === 'Download'
  )!;
  expect(button).toBeUndefined();
});

it.each([undefined, 2, 3])(
  'reloads stale page scripts with protocol %s after an extension update',
  async protocolVersion => {
    vi.mocked(loadPreferences).mockResolvedValue({
      video: true,
      transcript: true,
      automatic: false,
      reload: true,
    });
    vi.mocked(chrome.tabs.sendMessage).mockImplementationOnce(async () => ({
      success: true,
      data: {
        url: currentUrl,
        title: 'Old page',
        protocolVersion,
        sources: [],
        hasPlayer: false,
      },
    }));
    await render();
    expect(chrome.tabs.reload).toHaveBeenCalledOnce();
    expect(container.querySelector('.te-download-title')?.textContent).toBe('First lecture');
  }
);

function configureParallel() {
  const addresses: Record<number, string> = {
    42: 'https://www.youtube.com/watch?v=first',
    43: 'https://www.udemy.com/course/second/learn/lecture/1',
  };
  vi.mocked(loadPreferences).mockResolvedValue({
    video: true,
    transcript: false,
    automatic: false,
  });
  vi.mocked(loadDirectory).mockResolvedValue({
    name: 'Shared',
    ...folder,
    getDirectoryHandle: vi.fn(async () => folder),
  } as unknown as FileSystemDirectoryHandle);
  Object.assign(chrome, { scripting: { executeScript: vi.fn(async () => []) } });
  vi.mocked(chrome.tabs.sendMessage).mockImplementation(async (id, request) => {
    const type = (request as { type: string }).type;
    if (type === 'GET_DOWNLOAD_ITEMS')
      return {
        success: true,
        data: {
          sections: [{ lectures: [{ id: String(id), title: `Video ${id}`, url: addresses[id] }] }],
        },
      };
    if (type === 'GET_HLS_DOWNLOAD_CONTEXT')
      return {
        success: true,
        data: {
          protocolVersion: 4,
          url: addresses[id],
          title: `Video ${id}`,
          sources: [`https://r${id}.googlevideo.com/index.m3u8`],
          hasPlayer: true,
          loading: false,
          kind: 'video',
          protected: false,
        },
      };
    return { success: true, data: 'Transcript' };
  });
}
async function clickWorker(id: number, label: string) {
  const worker = container.querySelector(`[data-worker="${id}"]`)!;
  const button = [...worker.querySelectorAll('button')].find(
    button => button.textContent === label && button.closest('dialog')?.open !== false
  )!;
  expect(button).toBeTruthy();
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
}
it('finishes a prepared transfer after source closure without opening the next queued video', async () => {
  configureParallel();
  const originalSend = vi.mocked(chrome.tabs.sendMessage).getMockImplementation()!;
  vi.mocked(chrome.tabs.sendMessage).mockImplementation(async (...args) => {
    const result = (await originalSend(...args)) as unknown as {
      success: boolean;
      data: Record<string, unknown>;
    };
    if ((args[1] as { type: string }).type === 'GET_DOWNLOAD_ITEMS')
      return {
        success: true,
        data: {
          sections: [
            {
              lectures: ['first', 'second'].map(id => ({
                id,
                title: id,
                url: `https://www.youtube.com/watch?v=${id}&list=PL123`,
              })),
            },
          ],
        },
      };
    if ((args[1] as { type: string }).type === 'GET_HLS_DOWNLOAD_CONTEXT')
      return {
        ...result,
        data: { ...result.data, url: 'https://www.youtube.com/watch?v=first&list=PL123' },
      };
    return result;
  });
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  let release: ((response: Response) => void) | undefined;
  vi.mocked(fetch).mockImplementation(async (...args) =>
    String(args[0]).includes('r42.googlevideo.com/a.ts')
      ? new Promise<Response>(resolve => {
          release = resolve;
        })
      : originalFetch(...args)
  );
  const state = vi.fn();
  await act(async () => root.render(<VideoDownload sourceTabId={42} onStateChange={state} />));
  await click('Download');
  expect(state.mock.lastCall?.[1].transferring).toBe(true);
  await act(async () =>
    root.render(<VideoDownload sourceTabId={42} sourceClosed onStateChange={state} />)
  );
  const requests = vi.mocked(chrome.tabs.sendMessage).mock.calls.length;
  const ts = new Uint8Array(188);
  ts[0] = 0x47;
  await act(async () => release!(new Response(ts)));
  expect(Object.values(writes).filter(writer => writer.close.mock.calls.length)).toHaveLength(1);
  expect(chrome.tabs.update).not.toHaveBeenCalled();
  expect(chrome.tabs.reload).not.toHaveBeenCalled();
  expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.length).toBe(requests);
  expect(state.mock.lastCall?.[1].busy).toBe(false);
});

it('downloads an Udemy queue while a YouTube queue is transferring and cancels only the selected queue', async () => {
  configureParallel();
  const original = vi.mocked(fetch).getMockImplementation()!;
  let waiting = false;
  vi.mocked(fetch).mockImplementation(async (...args) => {
    if (String(args[0]).includes('r42.googlevideo.com/a.ts')) {
      waiting = true;
      return new Promise<Response>((_resolve, reject) => {
        (args[1] as RequestInit).signal!.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          { once: true }
        );
      });
    }
    return original(...args);
  });
  await act(async () =>
    root.render(
      <>
        <div data-worker="42">
          <VideoDownload sourceTabId={42} active={false} />
        </div>
        <div data-worker="43">
          <VideoDownload sourceTabId={43} />
        </div>
      </>
    )
  );
  await clickWorker(42, 'Download');
  expect(waiting).toBe(true);
  await clickWorker(43, 'Download');
  expect(container.querySelector('[data-worker="43"]')!.textContent).toMatch(
    /1 video(?: & transcript| \/ no transcript) downloaded/
  );
  expect(Object.values(writes).filter(writer => writer.close.mock.calls.length)).toHaveLength(1);
  await clickWorker(42, 'Cancel');
  expect(Object.values(writes).filter(writer => writer.abort.mock.calls.length)).toHaveLength(1);
  expect(container.querySelector('[data-worker="43"]')!.textContent).toMatch(
    /1 video(?: & transcript| \/ no transcript) downloaded/
  );
  expect(
    stored['download_queue:https://www.youtube.com/watch?v=first:true:false:tab:42']
  ).toBeDefined();
  expect(
    stored['download_queue:https://www.udemy.com/course/second:true:false:tab:43']
  ).toBeDefined();
});

it('keeps a background permission pause and resumes it when another queue grants the same host family', async () => {
  configureParallel();
  let granted = false;
  const listeners = new Set<() => void>();
  Object.assign(chrome.permissions, {
    onAdded: {
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
    },
  });
  vi.mocked(chrome.permissions.contains).mockImplementation(async () => granted);
  vi.mocked(chrome.permissions.request).mockImplementation(async () => {
    granted = true;
    for (const listener of listeners) listener();
    return true;
  });
  await act(async () =>
    root.render(
      <>
        <div data-worker="42">
          <VideoDownload sourceTabId={42} active={false} />
        </div>
        <div data-worker="43">
          <VideoDownload sourceTabId={43} />
        </div>
      </>
    )
  );
  await clickWorker(42, 'Download');
  await clickWorker(43, 'Download');
  expect(container.querySelector('[data-worker="42"] dialog')!.hasAttribute('open')).toBe(false);
  expect(container.querySelector('[data-worker="43"] dialog')!.hasAttribute('open')).toBe(true);
  await clickWorker(43, 'Allow listed video hosts');
  expect(chrome.permissions.request).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-worker="42"]')!.textContent).toMatch(
    /1 video(?: & transcript| \/ no transcript) downloaded/
  );
  expect(container.querySelector('[data-worker="43"]')!.textContent).toMatch(
    /1 video(?: & transcript| \/ no transcript) downloaded/
  );
});
it('shares a folder selected in one queue with the other registered queues', async () => {
  configureParallel();
  vi.mocked(loadDirectory).mockResolvedValue(null);
  await act(async () =>
    root.render(
      <>
        <div data-worker="42">
          <VideoDownload sourceTabId={42} screen="settings" />
        </div>
        <div data-worker="43">
          <VideoDownload sourceTabId={43} active={false} />
        </div>
      </>
    )
  );
  await clickWorker(42, 'Choose destination folder');
  expect(container.querySelector('[data-worker="43"]')!.textContent).toContain('Folder: Lessons');
  await clickWorker(43, 'Download');
  expect(container.querySelector('[data-worker="43"]')!.textContent).toMatch(
    /1 video(?: & transcript| \/ no transcript) downloaded/
  );
});
