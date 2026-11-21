// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://extension.test/video-download.html?tab=42" }
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VideoDownload } from './VideoDownload';
import {
  loadPreferences,
  savePreferences,
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
    getFileHandle: vi.fn(async (name: string) => ({
      createWritable: async () => {
        const writer = {
          write: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
          abort: vi.fn(async () => undefined),
        };
        writes[name] = writer;
        return writer;
      },
    })),
    removeEntry: vi.fn(async () => undefined),
  };
  vi.stubGlobal(
    'showDirectoryPicker',
    vi.fn(async () => ({ name: 'Lessons', getDirectoryHandle: vi.fn(async () => folder) }))
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
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
it('reloads a tab with an older content script and reconnects without reopening the downloader', async () => {
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
  expect(container.textContent).toContain('1 saved');
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
  expect(container.textContent).toContain('2/2 completed');
  expect(Object.keys(writes)).toHaveLength(4);
  expect(chrome.tabs.update).toHaveBeenCalledWith(42, { url: listing[1].url });
  await act(async () => {
    root.unmount();
  });
  root = createRoot(container);
  await render();
  expect(container.textContent).toContain('2/2 completed');
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
  const label = [...container.querySelectorAll('label')].find(value =>
    value.textContent?.includes('Item 2')
  )!;
  await act(async () => {
    (label.querySelector('input') as HTMLInputElement).click();
  });
  await click('Choose destination folder');
  await click('Download');
  expect(Object.keys(writes)).toHaveLength(2);
  expect(chrome.tabs.update).not.toHaveBeenCalled();
  expect(container.textContent).toContain('1/2 completed');
});
it('resumes a failed queue without repeating a completed video', async () => {
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
  expect(container.textContent).toContain('2/2 completed');
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

it('primes the player automatically without requiring the user to press play', async () => {
  vi.useFakeTimers();
  hasSources = false;
  const send = chrome.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>;
  const original = send.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
  send.mockImplementation(async (...args: unknown[]) => {
    if ((args[1] as { type: string }).type === 'PREPARE_DOWNLOAD') hasSources = true;
    return original(...args);
  });
  await render();
  await click('Choose destination folder');
  await click('Download');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(Object.keys(writes)).toHaveLength(2);
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
    42,
    { type: 'PREPARE_DOWNLOAD', data: undefined },
    { frameId: 0 }
  );
  expect(chrome.tabs.reload).not.toHaveBeenCalled();
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
  expect(container.textContent).toContain('1 saved');
  expect(Object.keys(writes)).toHaveLength(2);
  expect(Object.values(writes).every(writer => writer.close.mock.calls.length === 1)).toBe(true);
});

it('offers one primary download action for the chosen scope', async () => {
  await render();
  expect(container.querySelectorAll('section .te-btn-primary')).toHaveLength(1);
  listing = [1].map(id => ({
    id: String(id),
    title: `Item ${id}`,
    url: `https://www.udemy.com/course/test/learn/lecture/${id}`,
  }));
  expect(container.querySelectorAll('section .te-btn-primary')).toHaveLength(1);
  expect(container.querySelector('.te-btn-primary')?.textContent).toContain('Download');
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
  expect(hasDirectoryAccess).toHaveBeenCalledWith(expect.anything(), true);
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
  expect(container.textContent).toContain('Select all (2)');
});

it('does not invent an item from the current page when the curriculum is missing', async () => {
  listing = [];
  await render();
  expect(container.textContent).toContain('No videos were found in the course curriculum');
  expect(container.querySelectorAll('li input')).toHaveLength(0);
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
