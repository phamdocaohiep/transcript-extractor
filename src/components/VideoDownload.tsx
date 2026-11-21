import { useEffect, useRef, useState } from 'react';
import type { VideoDownloadContext } from '../lib/hls-discovery';
import {
  HostAccessNeeded,
  prepareVideo,
  saveDownload,
  completionKey,
  getFolderName,
} from '../lib/download';
import { lectureId } from '../lib/collection';
import { loadCourseCollection } from '../lib/collection-store';
import { groupKey } from '../lib/identity';
import { resolvePlayback, canRetryDownload } from '../lib/playback';
import { readStreams, selectStreams } from '../lib/stream-discovery';
import {
  loadPreferences,
  savePreferences,
  loadDirectory,
  saveDirectory,
  hasDirectoryAccess,
} from '../lib/preferences';
import type { DownloadItem, Preferences } from '../lib/download-types';

class PageConnectionError extends Error {}
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Download failed.');
const sleep = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(done, 500);
    function done() {
      signal.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', cancel, { once: true });
  });

export function VideoDownload({
  sourceTabId,
  screen = 'main',
  onBusyChange,
}: {
  sourceTabId?: number;
  screen?: 'main' | 'settings';
  onBusyChange?: (busy: boolean) => void;
} = {}) {
  const tabId = sourceTabId ?? Number(new URLSearchParams(location.search).get('tab'));

  const [context, setContext] = useState<VideoDownloadContext | null>(null);
  const [source, setSource] = useState('');
  const [title, setTitle] = useState('');
  const [directory, setDirectory] = useState<FileSystemDirectoryHandle | null>(null);
  const [access, setAccess] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>({
    video: true,
    transcript: true,
    automatic: false,
  });
  const [loaded, setLoaded] = useState(false);
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [hosts, setHosts] = useState<string[]>([]);
  const [accessError, setAccessError] = useState('');
  const [requestingAccess, setRequestingAccess] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0, bytes: 0 });
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  const working = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const automaticAttempt = useRef('');
  const resumeQueue = useRef(false);
  const accessDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = accessDialog.current;
    if (!dialog) return;
    if (hosts.length && !dialog.open) dialog.showModal();
    else if (!hosts.length && dialog.open) dialog.close();
  }, [hosts]);
  const settings = useRef(preferences);
  settings.current = preferences;

  function report(err: unknown) {
    if (err instanceof HostAccessNeeded) {
      setHosts(err.origins);
      setAccessError('');
    }
    setError(
      err instanceof DOMException && err.name === 'AbortError'
        ? 'Cancelled. You can retry.'
        : errorText(err)
    );
  }
  async function send(type: string, data?: unknown) {
    if (!Number.isSafeInteger(tabId) || tabId <= 0)
      throw new Error('Open the extension on the page you want to download.');
    return chrome.tabs.sendMessage(tabId, { type, data }, { frameId: 0 });
  }
  async function pageContext(): Promise<VideoDownloadContext> {
    let reply;
    try {
      reply = await send('GET_HLS_DOWNLOAD_CONTEXT');
    } catch {
      throw new PageConnectionError(
        'Could not connect to the lecture tab. Reload it and reconnect.'
      );
    }
    if (!reply?.success || !reply.data?.url || !Array.isArray(reply.data.sources)) {
      throw new PageConnectionError(
        reply?.error === 'Unknown message type'
          ? 'The lecture tab is running an older extension script. Reload it and reconnect.'
          : reply?.error ||
            'The lecture tab did not return video information. Reload it and reconnect.'
      );
    }
    const next = reply.data as VideoDownloadContext;
    const url = new URL(next.url);
    if (
      /(^|\.)youtube\.com$/.test(url.hostname) &&
      (url.pathname === '/watch' || url.pathname.startsWith('/shorts/'))
    ) {
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        func: readStreams,
      });
      const result = results[0]?.result;
      if (result && lectureId(result.url, '') === lectureId(next.url, ''))
        return {
          ...next,
          streams: result.streams,
          unavailable: result.unavailable,
          title: result.title || next.title,
          adaptive: result.adaptive,
          diagnostics: result.diagnostics,
          kind: 'video',
        };
    }
    return next;
  }
  async function waitForContext(
    signal: AbortSignal,
    url?: string,
    previous?: VideoDownloadContext
  ) {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      try {
        // Chrome can expose the destination URL before the new document and
        // content script have finished loading.
        if (chrome.tabs.get && (await chrome.tabs.get(tabId)).status === 'loading') {
          await sleep(signal);
          continue;
        }
        const next = await pageContext();
        const matches = url
          ? lectureId(next.url, '') === lectureId(url, '')
          : !previous || next.url !== previous.url;
        const fresh =
          !previous ||
          !settings.current.video ||
          (!next.sources.length && !next.loading) ||
          next.sources.some(item => !previous.sources.includes(item));
        if (matches && fresh && (!next.loading || next.sources.length)) return next;
      } catch (err) {
        if (!(err instanceof PageConnectionError)) throw err;
      }
      await sleep(signal);
    }
    throw new PageConnectionError('The selected page did not finish loading.');
  }
  async function refresh(reloadPage = false) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setHosts([]);
    setItems([]);
    automaticAttempt.current = '';
    const abort = new AbortController();
    controller.current = abort;
    try {
      if (reloadPage) await chrome.tabs.reload(tabId);
      let next: VideoDownloadContext;
      try {
        next = reloadPage ? await waitForContext(abort.signal) : await pageContext();
      } catch (err) {
        if (!(err instanceof PageConnectionError) || reloadPage) throw err;
        setNotice('Reconnecting to the page…');
        await chrome.tabs.reload(tabId);
        next = await waitForContext(abort.signal);
      }
      setContext(next);
      setSource(next.sources[0] || '');
      setNotice('');
    } catch (err) {
      setContext(null);
      report(err);
    } finally {
      working.current = false;
      setBusy(false);
      controller.current = null;
    }
  }
  async function connect(signal: AbortSignal): Promise<VideoDownloadContext> {
    try {
      return await pageContext();
    } catch (err) {
      if (!(err instanceof PageConnectionError)) throw err;
      setNotice('Reconnecting to the source page…');
      setBusy(true);
      await chrome.tabs.reload(tabId);
      return waitForContext(signal);
    }
  }
  const initialRefresh = useRef(refresh);
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const value = await loadPreferences();
        const folder = await loadDirectory().catch(() => null);
        const granted = folder ? await hasDirectoryAccess(folder).catch(() => false) : false;
        if (disposed) return;
        setPreferences(value);
        setDirectory(folder);
        setAccess(granted);
        setLoaded(true);
      } catch (err) {
        if (!disposed) report(err);
      }
      if (!disposed) await initialRefresh.current();
    })();
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.download_preferences_v1) {
        const value = changes.download_preferences_v1.newValue as Preferences;
        if (value) setPreferences(value);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    const warn = (event: BeforeUnloadEvent) => {
      if (working.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      disposed = true;
      controller.current?.abort();
      chrome.storage.onChanged.removeListener(listener);
      window.removeEventListener('beforeunload', warn);
    };
  }, []);

  useEffect(() => {
    const changed = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id !== tabId || info.status !== 'complete' || working.current) return;
      void pageContext()
        .then(next => {
          setContext(next);
          setSource(next.sources[0] || '');
        })
        .catch(report);
    };
    chrome.tabs.onUpdated?.addListener(changed);
    return () => chrome.tabs.onUpdated?.removeListener(changed);
    // Bind to one source tab. Jobs own navigation while working.current is true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  async function changePreferences(value: Preferences) {
    try {
      await savePreferences(value);
      setPreferences(value);
      setItems([]);
      automaticAttempt.current = '';
    } catch (err) {
      report(err);
    }
  }
  async function prepare(
    next: VideoDownloadContext,
    selected: string,
    signal: AbortSignal,
    includeVideo = preferences.video
  ) {
    if (includeVideo && next.protected)
      throw new Error('This player uses DRM. Protected video is not supported.');
    const nextPlan = includeVideo
      ? await prepareVideo(selected, signal, next.streams, next.adaptive)
      : null;
    let text = '';
    let warning = '';
    if (preferences.transcript) {
      try {
        const saved = await loadCourseCollection(next.url);
        text = saved.find(item => item.id === lectureId(next.url, ''))?.transcript || '';
        if (!text.trim()) {
          const response = await send('EXTRACT_TRANSCRIPT');
          if (!response?.success || typeof response.data !== 'string' || !response.data.trim())
            throw new Error(response?.error || 'No transcript was found for this item.');
          text = response.data;
        }
      } catch (err) {
        signal.throwIfAborted();
        if (!nextPlan) throw err;
        warning = `Video saved; transcript unavailable: ${errorText(err)}`;
      }
    }
    signal.throwIfAborted();
    const current = await pageContext();
    if (lectureId(current.url, '') !== lectureId(next.url, ''))
      throw new Error('The lecture tab changed. Refresh the detected streams before downloading.');
    return { plan: nextPlan, text, warning };
  }
  async function recover(next: VideoDownloadContext, signal: AbortSignal) {
    if (!preferences.video) return next;
    return resolvePlayback(
      next.url,
      pageContext,
      () => send('PREPARE_DOWNLOAD'),
      () => chrome.tabs.reload(tabId),
      signal,
      () => setNotice('Reloading the page and retrying the video…')
    );
  }
  async function saveWithRetry(next: VideoDownloadContext, signal: AbortSignal) {
    let current = next;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        current = await recover(current, signal);
        if (
          preferences.video &&
          current.hasPlayer === false &&
          !current.sources.length &&
          !selectStreams(current.streams || []) &&
          !current.adaptive
        ) {
          if (!preferences.transcript)
            return { status: 'skipped' as const, warning: 'This page has no video.' };
          let result;
          try {
            result = await prepare(current, '', signal, false);
          } catch (err) {
            if (/no transcript|no caption|not available|not found/i.test(errorText(err))) {
              setNotice('Skipped. This page has no video player or transcript.');
              return {
                status: 'skipped' as const,
                warning: 'This page has no video or transcript.',
              };
            }
            throw err;
          }
          await saveDownload(
            current,
            null,
            result.text,
            directory!,
            { ...preferences, video: false },
            signal,
            (completed, total, bytes) => setProgress({ completed, total, bytes }),
            setNotice
          );
          return { status: 'skipped' as const, warning: 'No video player. Transcript saved.' };
        }
        const result = await prepare(current, current.sources[0] || source, signal);
        await saveDownload(
          current,
          result.plan,
          result.text,
          directory!,
          { ...preferences, transcript: preferences.transcript && !!result.text.trim() },
          signal,
          (completed, total, bytes) => setProgress({ completed, total, bytes }),
          setNotice
        );
        setContext(current);
        if (result.warning) setNotice(result.warning);
        return {
          status: result.warning ? ('partial' as const) : ('completed' as const),
          warning: result.warning,
        };
      } catch (err) {
        if (attempt || !canRetryDownload(err)) throw err;
        signal.throwIfAborted();
        setNotice('Reloading the page and retrying the download…');
        await chrome.tabs.reload(tabId);
        current = await waitForContext(signal, current.url);
      }
    }
    throw new Error('Download did not finish.');
  }
  async function chooseFolder() {
    try {
      const picker = (
        window as unknown as {
          showDirectoryPicker(options: { mode: 'readwrite' }): Promise<FileSystemDirectoryHandle>;
        }
      ).showDirectoryPicker;
      if (!picker)
        throw new Error('Folder saving requires Chrome or Edge with File System Access support.');
      const folder = await picker.call(window, { mode: 'readwrite' });
      const granted = await hasDirectoryAccess(folder, true);
      if (!granted) throw new Error('Write access to the selected folder was not granted.');
      await saveDirectory(folder);
      setDirectory(folder);
      setAccess(true);
      setError('');
    } catch (err) {
      report(err);
    }
  }
  async function ensureDirectory(): Promise<boolean> {
    if (!directory) {
      setError('No download folder configured. Choose a folder in Settings before downloading.');
      return false;
    }
    try {
      // Called directly from Download so Chrome can show its native permission dialog.
      const granted = await hasDirectoryAccess(directory, true);
      setAccess(granted);
      if (!granted) setError('Folder access was not granted. Click Download to try again.');
      return granted;
    } catch (err) {
      report(err);
      return false;
    }
  }
  async function allowHosts() {
    if (requestingAccess) return;
    setRequestingAccess(true);
    setAccessError('');
    try {
      if (!(await chrome.permissions.request({ origins: hosts })))
        throw new Error('Video host access was not granted.');
      setHosts([]);
      setError('');
      automaticAttempt.current = '';
      setNotice('Host access granted. Resuming download…');
      if (resumeQueue.current) {
        resumeQueue.current = false;
        await runQueue();
      }
    } catch (err) {
      setAccessError(errorText(err));
      report(err);
    } finally {
      setRequestingAccess(false);
    }
  }
  const queueKey = (url: string) =>
    `download_queue:${groupKey(url)}:${preferences.video}:${preferences.transcript}`;
  async function persistItems(value: DownloadItem[], url: string) {
    await chrome.storage.local.set({ [queueKey(url)]: value });
    setItems(value.map(item => ({ ...item })));
  }
  async function loadItems() {
    if (working.current || !context) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('Loading items…');
    try {
      const response = await send('GET_DOWNLOAD_ITEMS');
      if (!response?.success) throw new Error(response?.error || 'Could not load the item list.');
      setTitle(response.data?.title || context.title);
      const sections = Array.isArray(response.data?.sections) ? response.data.sections : [];
      const stored = (await chrome.storage.local.get(queueKey(context.url)))[
        queueKey(context.url)
      ] as DownloadItem[] | undefined;
      const seen = new Set<string>();
      const next: DownloadItem[] = [];
      for (const section of sections) {
        for (const item of section.lectures ?? []) {
          if (item.kind === 'quiz' || item.kind === 'article') continue;
          if (!item.id || seen.has(item.id)) continue;
          seen.add(item.id);
          const previous = stored?.find(value => value.id === item.id);
          next.push({
            id: item.id,
            title: item.title || 'Untitled',
            section: section.title,
            url: item.url,
            selected: true,
            status: previous?.status === 'completed' ? previous.status : 'pending',
          });
        }
      }
      if (!next.length && /(^|\.)udemy\.com$/.test(new URL(context.url).hostname)) {
        throw new Error(
          'No videos were found in the course curriculum. Reload the course page and retry.'
        );
      }
      if (!next.length)
        next.push({
          id: lectureId(context.url, ''),
          title: context.title,
          url: context.url,
          selected: true,
          status: 'pending',
        });
      await persistItems(next, context.url);
    } catch (err) {
      report(err);
    } finally {
      setNotice('');
      working.current = false;
      setBusy(false);
    }
  }
  async function runQueue() {
    if (working.current || !context) return;
    working.current = true;
    setBusy(true);
    if (!(await ensureDirectory())) {
      working.current = false;
      setBusy(false);
      return;
    }
    setError('');
    const abort = new AbortController();
    controller.current = abort;
    const root = context.url;
    const next = items.map(item => ({ ...item }));
    try {
      const batch = (await chrome.storage.local.get('course_batch_state')).course_batch_state as
        | { isActive?: boolean; isPaused?: boolean }
        | undefined;
      if (batch?.isActive && !batch.isPaused)
        throw new Error('Pause transcript collection before starting video downloads.');
      await navigator.locks.request(`download-${tabId}`, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('Another download window is using this tab.');
        for (const item of next) {
          if (!item.selected || item.status === 'completed' || item.status === 'skipped') continue;
          abort.signal.throwIfAborted();
          item.status = 'downloading';
          item.error = undefined;
          await persistItems([...next], root);
          try {
            let current = await connect(abort.signal);
            if (item.url && lectureId(current.url, '') !== lectureId(item.url, '')) {
              if (groupKey(item.url) !== groupKey(root))
                throw new Error('Item URL is outside this collection.');
              await chrome.tabs.update(tabId, { url: item.url });
              current = await waitForContext(abort.signal, item.url);
            } else if (!item.url) {
              const previous = current;
              const reply = await send('OPEN_DOWNLOAD_ITEM', { id: item.id, title: item.title });
              if (!reply?.success) throw new Error(reply?.error || 'Could not open this item.');
              current = await waitForContext(abort.signal, undefined, previous);
            }
            if (groupKey(current.url) !== groupKey(root))
              throw new Error('The source tab left this collection.');
            setContext(current);
            setSource(current.sources[0] || '');
            automaticAttempt.current = `${lectureId(current.url, '')}:${preferences.video}:${preferences.transcript}`;
            const saved = await saveWithRetry(current, abort.signal);
            item.status = saved.status;
            item.error = saved.warning || undefined;
          } catch (err) {
            item.status = 'failed';
            item.error = errorText(err);
            await persistItems([...next], root);
            if (
              err instanceof HostAccessNeeded ||
              abort.signal.aborted ||
              /Subscription|HTTP (401|403)/i.test(errorText(err))
            )
              throw err;
            continue;
          }
          await persistItems([...next], root);
        }
        setNotice(
          `Finished: ${next.filter(item => item.status === 'completed').length} saved, ${next.some(item => item.status === 'partial') ? `${next.filter(item => item.status === 'partial').length} video saved without transcript, ` : ''}${next.filter(item => item.status === 'skipped').length} without video, ${next.filter(item => item.status === 'failed').length} failed.`
        );
      });
    } catch (err) {
      if (err instanceof HostAccessNeeded) resumeQueue.current = true;
      report(err);
    } finally {
      working.current = false;
      setBusy(false);
      controller.current = null;
    }
  }
  const loadedList = useRef('');
  useEffect(() => {
    if (!loaded || busy || !context) return;
    const key = `${groupKey(context.url)}:${preferences.video}:${preferences.transcript}`;
    if (loadedList.current === key) return;
    loadedList.current = key;
    void loadItems();
  });

  // A persistent download tab watches the source tab while automatic downloading is enabled.
  useEffect(() => {
    if (
      !loaded ||
      !preferences.automatic ||
      !directory ||
      !access ||
      (!preferences.video && !preferences.transcript)
    )
      return;
    const timer = setInterval(() => {
      if (working.current) return;
      working.current = true;
      void (async () => {
        const abort = new AbortController();
        controller.current = abort;
        try {
          const next = await connect(abort.signal);
          const key = `${lectureId(next.url, '')}:${preferences.video}:${preferences.transcript}`;
          if (automaticAttempt.current === key) return;
          automaticAttempt.current = key;
          const completed = (await chrome.storage.local.get(completionKey(next.url)))[
            completionKey(next.url)
          ] as { video?: boolean; transcript?: boolean } | undefined;
          if (
            (!preferences.video || completed?.video) &&
            (!preferences.transcript || completed?.transcript)
          )
            return;
          working.current = true;
          setBusy(true);
          setError('');
          await navigator.locks.request(`download-${tabId}`, { ifAvailable: true }, async lock => {
            if (!lock) throw new Error('Another download window is using this tab.');
            await saveWithRetry(next, abort.signal);
          });
          setContext(next);
          setSource(next.sources[0] || '');
          if (context && groupKey(context.url) !== groupKey(next.url)) setItems([]);
        } catch (err) {
          report(err);
        } finally {
          working.current = false;
          setBusy(false);
          controller.current = null;
        }
      })();
    }, 2000);
    return () => clearInterval(timer);
    // The timer is renewed whenever the saved preferences or destination change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, preferences, directory, access]);

  const validChoice = preferences.video || preferences.transcript;
  return (
    <main className="flex flex-col gap-3">
      <section
        hidden={screen !== 'settings'}
        style={{ display: screen === 'settings' ? undefined : 'none' }}
        className="te-glass p-3 flex flex-col gap-3"
      >
        <h2 className="font-semibold">Download settings</h2>
        <label>
          <input
            type="checkbox"
            checked={preferences.video}
            disabled={busy || !loaded}
            onChange={e => void changePreferences({ ...preferences, video: e.target.checked })}
          />{' '}
          Video (MP4 / WebM)
        </label>
        <label>
          <input
            type="checkbox"
            checked={preferences.transcript}
            disabled={busy || !loaded}
            onChange={e => void changePreferences({ ...preferences, transcript: e.target.checked })}
          />{' '}
          Transcript (Markdown)
        </label>
        <label>
          <input
            type="checkbox"
            checked={preferences.automatic}
            disabled={busy || !loaded}
            onChange={e => void changePreferences({ ...preferences, automatic: e.target.checked })}
          />{' '}
          Automatically download when a video becomes ready
        </label>
        <p className="te-muted text-sm">
          Settings are saved in this Chrome profile across extension updates.
        </p>
        <button className="te-btn" disabled={busy} onClick={() => void chooseFolder()}>
          {directory ? `Folder: ${directory.name} — change` : 'Choose destination folder'}
        </button>
        {!validChoice && <p role="alert">Choose video or transcript.</p>}
      </section>
      <section
        hidden={screen !== 'main'}
        style={{ display: screen === 'main' ? undefined : 'none' }}
        className="te-glass p-5 flex flex-col gap-3"
      >
        <h2 className="font-semibold">{title || context?.title || 'Connect to a lecture'}</h2>
        {directory && (
          <p className="te-muted text-xs break-words">
            Save to {directory.name}
            {context ? `/${getFolderName(context.url)}` : ''}
          </p>
        )}
        {!!items.length && (
          <div className="flex flex-col gap-3">
            <label>
              <input
                type="checkbox"
                disabled={busy}
                checked={items.every(item => item.selected)}
                onChange={e =>
                  void persistItems(
                    items.map(item => ({ ...item, selected: e.target.checked })),
                    context!.url
                  ).catch(report)
                }
              />{' '}
              Select all ({items.length})
            </label>
            <ul className="flex flex-col">
              {items.map((item, index) => (
                <li key={item.id} className="py-2">
                  {item.section && (index === 0 || items[index - 1].section !== item.section) && (
                    <h3 className="font-semibold mb-3">{item.section}</h3>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={item.selected}
                      onChange={e =>
                        void persistItems(
                          items.map(value =>
                            value.id === item.id ? { ...value, selected: e.target.checked } : value
                          ),
                          context!.url
                        ).catch(report)
                      }
                    />{' '}
                    {item.title}
                  </label>
                  <span className="te-muted text-sm">
                    {' '}
                    — {item.status}
                    {item.error ? ` · ${item.error}` : ''}
                  </span>
                </li>
              ))}
            </ul>
            <p className="te-muted text-xs">
              {items.filter(item => item.selected).length} selected ·{' '}
              {items.filter(item => item.status === 'completed').length}/{items.length} completed
            </p>
          </div>
        )}
        <button
          className="te-btn-primary"
          disabled={
            busy ||
            !context ||
            !validChoice ||
            !items.some(
              item => item.selected && item.status !== 'completed' && item.status !== 'skipped'
            )
          }
          onClick={() => void runQueue()}
        >
          Download
        </button>
      </section>
      <dialog
        ref={accessDialog}
        aria-labelledby="access-title"
        className="te-glass fixed inset-0 m-auto max-w-[calc(100%-2rem)] w-96 p-5 backdrop:bg-black/60"
        style={{ background: 'var(--te-bg)', color: 'var(--te-text)' }}
        onCancel={() => {
          setHosts([]);
          resumeQueue.current = false;
          setError('Video access was not granted. Click Download to try again.');
        }}
      >
        <div className="flex flex-col gap-4">
          <h2 id="access-title" className="font-semibold">
            Allow video downloads
          </h2>
          <p>
            Chrome needs your permission to download from these hosts. Allow access to continue.
          </p>
          <ul>
            {hosts.map(host => (
              <li key={host}>{new URL(host).hostname}</li>
            ))}
          </ul>
          {accessError && <p role="alert">{accessError}</p>}
          <button
            className="te-btn-primary"
            disabled={busy || requestingAccess}
            onClick={() => void allowHosts()}
          >
            Allow listed video hosts
          </button>
          <button
            className="te-btn"
            onClick={() => {
              setHosts([]);
              resumeQueue.current = false;
              setError('Video access was not granted. Click Download to try again.');
            }}
          >
            Cancel
          </button>
        </div>
      </dialog>
      {(progress.total > 0 || progress.bytes > 0) && (
        <div>
          {progress.total > 0 && (
            <progress className="w-full" value={progress.completed} max={progress.total} />
          )}
          <p>
            {progress.total ? `${progress.completed}/${progress.total} parts · ` : ''}
            {(progress.bytes / 1048576).toFixed(1)} MB downloaded
          </p>
        </div>
      )}
      {busy && (
        <button className="te-btn" onClick={() => controller.current?.abort()}>
          Cancel
        </button>
      )}
      {notice && (
        <p role="status" className="te-glass p-4">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="te-note te-note--warn p-4">
          {error}
        </p>
      )}
    </main>
  );
}
