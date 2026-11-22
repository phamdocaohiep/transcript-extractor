import { useEffect, useRef, useState } from 'react';
import type { VideoDownloadContext } from '../lib/hls-discovery';
import { PROTOCOL_VERSION } from '../lib/hls-discovery';
import { Trash2, X, Download } from 'lucide-react';
import { Preview } from './Preview';
import {
  HostAccessNeeded,
  prepareVideo,
  saveDownload,
  completionKey,
  inspectVideo,
  type Rendition,
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
import { selectionKey } from '../lib/download-types';
import { getSaved, getCounts } from '../lib/result-state';
import { startRun, classifyError, type Trace } from '../lib/diagnostics';

class PageConnectionError extends Error {}
export interface QueueState {
  busy: boolean;
  needsAccess: boolean;
  title: string;
  saved: number;
  total: number;
  error: boolean;
}
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
  active = true,
  settingsLocked = false,
  onStateChange,
  onClose,
}: {
  sourceTabId?: number;
  screen?: 'main' | 'settings';
  onBusyChange?: (busy: boolean) => void;
  active?: boolean;
  settingsLocked?: boolean;
  onStateChange?: (tabId: number, state: QueueState) => void;
  onClose?: () => void;
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
  const [listSize, setListSize] = useState<{
    loaded: number;
    expected: number;
    unique: number;
  } | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [renditions, setRenditions] = useState<Rendition[]>([]);
  const [qualityNotice, setQualityNotice] = useState('');
  const [qualityLoading, setQualityLoading] = useState(false);
  const qualityController = useRef<AbortController | null>(null);
  const removed = useRef(new Set<string>());
  useEffect(() => {
    if (!context || !preferences.video) return;
    const abort = new AbortController();
    setRenditions([]);
    setQualityNotice('');
    setQualityLoading(false);
    void inspectVideo(context, abort.signal)
      .then(value => {
        if (!abort.signal.aborted) setRenditions(value);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setQualityNotice(
            'Available qualities will appear when the player exposes them. Auto uses the source quality.'
          );
      });
    return () => {
      abort.abort();
      qualityController.current?.abort();
    };
  }, [context, preferences.video]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [hosts, setHosts] = useState<string[]>([]);
  const [accessError, setAccessError] = useState('');
  const [requestingAccess, setRequestingAccess] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0, bytes: 0 });
  const counts = getCounts(items, preferences);
  useEffect(() => {
    onStateChange?.(tabId, {
      busy,
      needsAccess: hosts.length > 0,
      title: title || context?.title || '',
      saved: counts.saved,
      total: counts.total,
      error: !!error,
    });
  }, [
    onStateChange,
    tabId,
    busy,
    hosts.length,
    title,
    context?.title,
    counts.saved,
    counts.total,
    error,
  ]);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  const working = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const automaticAttempt = useRef('');
  const resumeQueue = useRef(false);
  const requesting = useRef(false);
  const continueQueue = useRef<() => Promise<void>>(async () => undefined);
  const accessDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = accessDialog.current;
    if (!dialog) return;
    if (active && hosts.length && !dialog.open) dialog.showModal();
    else if ((!active || !hosts.length) && dialog.open) dialog.close();
  }, [hosts, active]);
  const settings = useRef(preferences);
  const trace = useRef<Trace>(() => undefined);
  settings.current = preferences;

  function report(err: unknown) {
    if (err instanceof HostAccessNeeded) {
      setHosts(err.origins);
      setAccessError('');
      trace.current('run_paused', { code: 'host_access', origins: err.origins });
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
    if (reply.data.protocolVersion !== PROTOCOL_VERSION)
      throw new PageConnectionError(
        'The page is running an older extension script. Reconnecting after reload.'
      );
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
    const directoryChanged = (event: Event) => {
      const folder = (event as CustomEvent<FileSystemDirectoryHandle>).detail;
      setDirectory(folder);
      void hasDirectoryAccess(folder)
        .then(granted => {
          if (!disposed) setAccess(granted);
        })
        .catch(report);
    };
    window.addEventListener('download-directory-changed', directoryChanged);
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
      window.removeEventListener('download-directory-changed', directoryChanged);
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
      if (
        value.video !== preferences.video ||
        value.transcript !== preferences.transcript ||
        selectionKey(value) !== selectionKey(preferences)
      ) {
        setItems([]);
        removed.current.clear();
      }
      automaticAttempt.current = '';
    } catch (err) {
      report(err);
    }
  }
  async function prepare(
    next: VideoDownloadContext,
    selected: string,
    signal: AbortSignal,
    includeVideo = preferences.video,
    includeTranscript = preferences.transcript,
    savedVideo = false
  ) {
    if (includeVideo && next.protected)
      throw new Error('This player uses DRM. Protected video is not supported.');
    const nextPlan = includeVideo
      ? await prepareVideo(
          selected,
          signal,
          next.streams,
          next.adaptive,
          trace.current,
          preferences
        )
      : null;
    let text = '';
    let warning = '';
    if (includeTranscript) {
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
        trace.current('transcript_failed', { code: classifyError(err) });
        if (!nextPlan && !savedVideo) throw err;
        warning = `Video saved; transcript unavailable: ${errorText(err)}`;
      }
    }
    signal.throwIfAborted();
    const current = await pageContext();
    if (lectureId(current.url, '') !== lectureId(next.url, ''))
      throw new Error('The lecture tab changed. Refresh the detected streams before downloading.');
    return { plan: nextPlan, text, warning };
  }
  async function recover(
    next: VideoDownloadContext,
    signal: AbortSignal,
    includeVideo = preferences.video
  ) {
    if (!includeVideo) return next;
    return resolvePlayback(
      next.url,
      pageContext,
      () => send('PREPARE_DOWNLOAD'),
      () => chrome.tabs.reload(tabId),
      signal,
      () => {
        trace.current('retry');
        setNotice('Reloading the page and retrying the video…');
      }
    );
  }
  async function saveWithRetry(
    next: VideoDownloadContext,
    signal: AbortSignal,
    saved = { video: false, transcript: false }
  ) {
    const choice = {
      ...preferences,
      video: preferences.video && !saved.video,
      transcript: preferences.transcript && !saved.transcript,
    };
    let current = next;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        current = await recover(current, signal, choice.video);
        if (
          choice.video &&
          current.hasPlayer === false &&
          !current.sources.length &&
          !selectStreams(current.streams || []) &&
          !current.adaptive
        ) {
          if (!choice.transcript)
            return { status: 'skipped' as const, warning: 'This page has no video.', saved };
          let result;
          try {
            result = await prepare(current, '', signal, false, choice.transcript);
          } catch (err) {
            if (/no transcript|no caption|not available|not found/i.test(errorText(err))) {
              setNotice('Skipped. This page has no video player or transcript.');
              return {
                status: 'skipped' as const,
                warning: 'This page has no video or transcript.',
                saved,
              };
            }
            throw err;
          }
          await saveDownload(
            current,
            null,
            result.text,
            directory!,
            { ...choice, video: false },
            signal,
            (completed, total, bytes) => setProgress({ completed, total, bytes }),
            setNotice,
            trace.current
          );
          return {
            status: 'skipped' as const,
            warning: 'No video player. Transcript saved.',
            saved: { ...saved, transcript: true },
          };
        }
        const result = await prepare(
          current,
          current.sources[0] || source,
          signal,
          choice.video,
          choice.transcript,
          preferences.video && saved.video
        );
        const actual = { ...choice, transcript: choice.transcript && !!result.text.trim() };
        if (actual.video || actual.transcript)
          await saveDownload(
            current,
            result.plan,
            result.text,
            directory!,
            actual,
            signal,
            (completed, total, bytes) => setProgress({ completed, total, bytes }),
            setNotice,
            trace.current
          );
        setContext(current);
        if (result.warning) setNotice(result.warning);
        return {
          status: result.warning ? ('partial' as const) : ('completed' as const),
          warning: result.warning,
          saved: {
            video: saved.video || actual.video,
            transcript: saved.transcript || actual.transcript,
          },
        };
      } catch (err) {
        if (attempt || !canRetryDownload(err)) throw err;
        signal.throwIfAborted();
        setNotice('Reloading the page and retrying the download…');
        trace.current('retry', { code: classifyError(err) });
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
      window.dispatchEvent(new CustomEvent('download-directory-changed', { detail: folder }));
      setDirectory(folder);
      setAccess(true);
      setError('');
    } catch (err) {
      report(err);
    }
  }
  async function ensureDirectory(): Promise<boolean> {
    if (!directory) {
      trace.current('directory_result', { configured: false, granted: false });
      setError('No download folder configured. Choose a folder in Settings before downloading.');
      return false;
    }
    try {
      // Called directly from Download so Chrome can show its native permission dialog.
      const granted = await hasDirectoryAccess(directory, true, () =>
        trace.current('permission_requested', { permission: 'directory' })
      );
      trace.current('directory_result', { configured: true, granted });
      setAccess(granted);
      if (granted)
        window.dispatchEvent(new CustomEvent('download-directory-changed', { detail: directory }));
      if (!granted) setError('Folder access was not granted. Click Download to try again.');
      return granted;
    } catch (err) {
      report(err);
      return false;
    }
  }
  async function allowHosts() {
    if (requesting.current) return;
    requesting.current = true;
    setRequestingAccess(true);
    setAccessError('');
    try {
      trace.current('permission_requested', { permission: 'host', origins: hosts });
      const granted = await chrome.permissions.request({ origins: hosts });
      trace.current('permission_result', { permission: 'host', origins: hosts, granted });
      if (!granted) throw new Error('Video host access was not granted.');
      setHosts([]);
      setError('');
      automaticAttempt.current = '';
      setNotice('Host access granted. Resuming download…');
      if (resumeQueue.current) {
        resumeQueue.current = false;
        await runQueue(true);
      }
    } catch (err) {
      setAccessError(errorText(err));
      report(err);
    } finally {
      requesting.current = false;
      setRequestingAccess(false);
    }
  }
  const legacyQueueKey = (url: string) =>
    `download_queue:${groupKey(url)}:${preferences.video}:${preferences.transcript}${preferences.format || preferences.maxHeight ? `:quality:${selectionKey(preferences)}` : ''}`;
  const queueKey = (url: string) => `${legacyQueueKey(url)}:tab:${tabId}`;
  async function persistItems(value: DownloadItem[], url: string) {
    await chrome.storage.local.set({ [queueKey(url)]: value });
    setItems(value.map(item => ({ ...item })));
  }
  async function loadItems() {
    if (working.current || !context) return;
    working.current = true;
    const abort = new AbortController();
    controller.current = abort;
    const cancel = () => {
      void send('CANCEL_DOWNLOAD_ITEMS').catch(() => undefined);
    };
    abort.signal.addEventListener('abort', cancel, { once: true });
    const listingTrace = startRun('list', tabId);
    setBusy(true);
    setError('');
    setNotice('Loading items…');
    setListFailed(false);
    try {
      const response = await send('GET_DOWNLOAD_ITEMS');
      abort.signal.throwIfAborted();
      if (!response?.success) throw new Error(response?.error || 'Could not load the item list.');
      setTitle(response.data?.title || context.title);
      const sections = Array.isArray(response.data?.sections) ? response.data.sections : [];
      const keys = sections.flatMap((section: { lectures?: Array<{ url?: string }> }) =>
        (section.lectures || []).flatMap(item =>
          item.url ? [completionKey(item.url), completionKey(item.url, preferences)] : []
        )
      );
      const completedFiles = keys.length ? await chrome.storage.local.get(keys) : {};
      const storedQueues = await chrome.storage.local.get([
        queueKey(context.url),
        legacyQueueKey(context.url),
      ]);
      const stored = (storedQueues[queueKey(context.url)] ??
        storedQueues[legacyQueueKey(context.url)]) as DownloadItem[] | undefined;
      const seen = new Set<string>();
      const next: DownloadItem[] = [];
      for (const section of sections) {
        for (const item of section.lectures ?? []) {
          if (item.kind === 'quiz' || item.kind === 'article') continue;
          if (!item.id || seen.has(item.id)) continue;
          seen.add(item.id);
          const previous = stored?.find(value => value.id === item.id);
          const previousFiles = previous
            ? getSaved(previous, preferences)
            : { video: false, transcript: false };
          const completed = item.url
            ? (completedFiles[completionKey(item.url, preferences)] as
                | { video?: boolean; transcript?: boolean }
                | undefined)
            : undefined;
          const shared = item.url
            ? (completedFiles[completionKey(item.url)] as { transcript?: boolean } | undefined)
            : undefined;
          const saved = {
            video: previousFiles.video || completed?.video === true,
            transcript:
              previousFiles.transcript ||
              completed?.transcript === true ||
              shared?.transcript === true,
          };
          const complete =
            (preferences.video || preferences.transcript) &&
            (!preferences.video || saved.video) &&
            (!preferences.transcript || saved.transcript);
          const partial =
            preferences.video && saved.video && preferences.transcript && !saved.transcript;
          next.push({
            id: item.id,
            title: item.title || 'Untitled',
            section: section.title,
            url: item.url,
            selected: item.available !== false,
            available: item.available !== false,
            status:
              item.available === false
                ? 'skipped'
                : complete
                  ? 'completed'
                  : partial
                    ? 'partial'
                    : 'pending',
            saved,
            error:
              item.available === false
                ? 'This entry is unavailable in the playlist.'
                : previous?.status === 'partial'
                  ? previous.error
                  : undefined,
          });
        }
      }
      if (!next.length && /(^|\.)udemy\.com$/.test(new URL(context.url).hostname)) {
        setListFailed(true);
        if (
          !context.hasPlayer &&
          !context.sources.length &&
          !context.streams?.length &&
          !context.adaptive
        )
          throw new Error('The video list is not ready. Open Course content and retry the list.');
        setError(
          'Only the current video is available. Retry the list to load the remaining videos.'
        );
      }
      if (!next.length) {
        const key = completionKey(context.url, preferences);
        const base = completionKey(context.url);
        const marks = await chrome.storage.local.get([key, base]);
        const shared = marks[base] as { transcript?: boolean } | undefined;
        const previous = marks[key] as { video?: boolean; transcript?: boolean } | undefined;
        const saved = {
          video: previous?.video === true,
          transcript: previous?.transcript === true || shared?.transcript === true,
        };
        const complete =
          (!preferences.video || saved.video) && (!preferences.transcript || saved.transcript);
        next.push({
          id: lectureId(context.url, ''),
          title: context.title,
          url: context.url,
          selected: true,
          saved,
          status: complete
            ? 'completed'
            : saved.video && preferences.transcript && !saved.transcript
              ? 'partial'
              : 'pending',
        });
      }
      const visibleItems = next.filter(
        item => !removed.current.has(`${groupKey(context.url)}:${item.id}`)
      );
      await persistItems(visibleItems, context.url);
      const loadedCount = Number(response.data?.loadedItems) || next.length;
      const expectedCount = Number(response.data?.totalItems) || loadedCount;
      setListSize({ loaded: loadedCount, expected: expectedCount, unique: visibleItems.length });
      listingTrace('list_loaded', { loadedCount, expectedCount, uniqueCount: next.length });
      listingTrace('run_finished', {
        result: loadedCount < expectedCount ? 'partial' : 'completed',
        total: next.length,
      });
    } catch (err) {
      setListFailed(true);
      listingTrace('run_finished', { result: 'failed', code: classifyError(err) });
      report(err);
    } finally {
      abort.signal.removeEventListener('abort', cancel);
      if (controller.current === abort) controller.current = null;
      setNotice('');
      working.current = false;
      setBusy(false);
    }
  }
  continueQueue.current = () => runQueue(true);
  useEffect(() => {
    if (!hosts.length) return;
    let disposed = false;
    const granted = () => {
      if (requesting.current) return;
      void chrome.permissions
        .contains({ origins: hosts })
        .then(async allowed => {
          if (!allowed || disposed || requesting.current) return;
          setHosts([]);
          setError('');
          automaticAttempt.current = '';
          trace.current('permission_result', { permission: 'host', origins: hosts, granted: true });
          if (resumeQueue.current) {
            resumeQueue.current = false;
            await continueQueue.current();
          }
        })
        .catch(report);
    };
    chrome.permissions.onAdded?.addListener(granted);
    granted();
    return () => {
      disposed = true;
      chrome.permissions.onAdded?.removeListener(granted);
    };
  }, [hosts]);
  async function runQueue(resume = false) {
    if (working.current || !context) return;
    working.current = true;
    if (!resume) trace.current = startRun('manual', tabId);
    trace.current('discovery', {
      video: preferences.video,
      transcript: preferences.transcript,
      automatic: preferences.automatic,
    });
    setBusy(true);
    if (!(await ensureDirectory())) {
      trace.current('run_finished', { result: 'failed', code: 'storage' });
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
            automaticAttempt.current = `${lectureId(current.url, '')}:${preferences.video}:${preferences.transcript}:${selectionKey(preferences)}`;
            trace.current('discovery', {
              source: /(^|\.)youtube\.com$/.test(new URL(current.url).hostname)
                ? 'youtube'
                : /(^|\.)udemy\.com$/.test(new URL(current.url).hostname)
                  ? 'udemy'
                  : 'other',
              player: current.hasPlayer,
              loading: current.loading,
              adaptive: !!current.adaptive,
              directCount: current.sources.length + (current.streams?.length || 0),
              formatCount: current.adaptive?.formats.length || 0,
            });
            const saved = await saveWithRetry(current, abort.signal, getSaved(item, preferences));
            item.status = saved.status;
            item.error = saved.warning || undefined;
            item.saved = saved.saved;
            trace.current('item_result', {
              item: next.indexOf(item) + 1,
              result: saved.status,
              video: saved.saved.video,
              transcript: saved.saved.transcript,
            });
          } catch (err) {
            item.status = 'failed';
            item.error = errorText(err);
            trace.current('item_result', {
              item: next.indexOf(item) + 1,
              result: 'failed',
              code: classifyError(err),
            });
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
        const counts = getCounts(next, preferences);
        setNotice(
          `Finished: ${counts.saved} saved, ${counts.partial ? `${counts.partial} video saved without transcript, ` : ''}${counts.skipped} without video, ${counts.failed} failed.`
        );
        trace.current('run_finished', {
          total: counts.total,
          video: counts.video > 0,
          transcript: counts.transcript > 0,
          result: counts.failed ? 'failed' : counts.partial ? 'partial' : 'completed',
        });
      });
    } catch (err) {
      if (err instanceof HostAccessNeeded) resumeQueue.current = true;
      else
        trace.current('run_finished', {
          result: abort.signal.aborted ? 'cancelled' : 'failed',
          code: classifyError(err),
        });
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
    const key = `${groupKey(context.url)}:${preferences.video}:${preferences.transcript}:${selectionKey(preferences)}`;
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
          const address = new URL(next.url);
          if (/(^|\.)youtube\.com$/.test(address.hostname) && address.pathname === '/playlist')
            return;
          const key = `${lectureId(next.url, '')}:${preferences.video}:${preferences.transcript}:${selectionKey(preferences)}`;
          if (automaticAttempt.current === key) return;
          automaticAttempt.current = key;
          const marks = await chrome.storage.local.get([
            completionKey(next.url),
            completionKey(next.url, preferences),
          ]);
          const selected = marks[completionKey(next.url, preferences)] as
            | { video?: boolean; transcript?: boolean }
            | undefined;
          const shared = marks[completionKey(next.url)] as { transcript?: boolean } | undefined;
          const completed = {
            video: selected?.video,
            transcript: selected?.transcript || shared?.transcript,
          };
          if (
            (!preferences.video || completed?.video) &&
            (!preferences.transcript || completed?.transcript)
          )
            return;
          working.current = true;
          setBusy(true);
          setError('');
          trace.current = startRun('automatic', tabId);
          trace.current('discovery', {
            video: preferences.video,
            transcript: preferences.transcript,
            automatic: true,
            adaptive: !!next.adaptive,
          });
          await navigator.locks.request(`download-${tabId}`, { ifAvailable: true }, async lock => {
            if (!lock) throw new Error('Another download window is using this tab.');
            const result = await saveWithRetry(next, abort.signal, {
              video: completed?.video === true,
              transcript: completed?.transcript === true,
            });
            trace.current('item_result', {
              result: result.status,
              video: result.saved.video,
              transcript: result.saved.transcript,
            });
            const stored = (await chrome.storage.local.get(queueKey(next.url)))[
              queueKey(next.url)
            ] as DownloadItem[] | undefined;
            if (stored?.length) {
              const id = lectureId(next.url, '');
              await persistItems(
                stored.map(item =>
                  item.url && lectureId(item.url, '') === id
                    ? {
                        ...item,
                        status: result.status,
                        saved: result.saved,
                        error: result.warning || undefined,
                      }
                    : item
                ),
                next.url
              );
            }
            trace.current('run_finished', {
              result: result.status,
              video: result.saved.video,
              transcript: result.saved.transcript,
            });
          });
          setContext(next);
          setSource(next.sources[0] || '');
          if (context && groupKey(context.url) !== groupKey(next.url)) setItems([]);
        } catch (err) {
          trace.current('run_finished', { result: 'failed', code: classifyError(err) });
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
  const incomplete = !!listSize && listSize.loaded < listSize.expected;
  const eligible = items.filter(item => item.available !== false);
  const single = items.length === 1 ? items[0] : undefined;
  function renderStatus(item: DownloadItem) {
    return (
      <div className="te-item-status">
        <span className="te-muted text-sm">
          {' '}
          — {item.status === 'partial' ? 'Video saved; transcript missing' : item.status}
        </span>
        {(getSaved(item, preferences).video || getSaved(item, preferences).transcript) && (
          <button
            className="te-small-button"
            type="button"
            aria-label={`Remove downloaded item: ${item.title}`}
            title="Remove from list; keep saved files"
            disabled={busy}
            onClick={() => {
              removed.current.add(`${groupKey(context!.url)}:${item.id}`);
              void persistItems(
                items.filter(value => value.id !== item.id),
                context!.url
              ).catch(report);
            }}
          >
            <Trash2 size={14} />
          </button>
        )}
        {item.error && <span className="te-muted text-sm"> · {item.error}</span>}
      </div>
    );
  }
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
            disabled={busy || settingsLocked || !loaded}
            onChange={e => void changePreferences({ ...preferences, video: e.target.checked })}
          />{' '}
          Video (MP4 / WebM)
        </label>
        <label>
          <input
            type="checkbox"
            checked={preferences.transcript}
            disabled={busy || settingsLocked || !loaded}
            onChange={e => void changePreferences({ ...preferences, transcript: e.target.checked })}
          />{' '}
          Transcript (Markdown)
        </label>
        <label>
          <input
            type="checkbox"
            checked={preferences.automatic}
            disabled={busy || settingsLocked || !loaded}
            onChange={e => void changePreferences({ ...preferences, automatic: e.target.checked })}
          />{' '}
          Automatically download when a video becomes ready
        </label>
        <p className="te-muted text-sm">
          Settings are saved in this Chrome profile across extension updates.
        </p>
        <button
          className="te-btn"
          disabled={busy || settingsLocked}
          onClick={() => void chooseFolder()}
        >
          {directory ? `Folder: ${directory.name} — change` : 'Choose destination folder'}
        </button>
        {!validChoice && <p role="alert">Choose video or transcript.</p>}
      </section>
      <section
        hidden={screen !== 'main'}
        style={{ display: screen === 'main' ? undefined : 'none' }}
        className="te-glass te-download-card"
      >
        {onClose && (
          <button
            type="button"
            className="te-small-button te-card-close"
            aria-label="Close queue"
            title="Close queue"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        )}
        <div className="te-download-card-head">
          <label className="te-preview-selection">
            <Preview
              url={
                items.find(item => item.url === context?.url)?.url ||
                items.find(item => item.selected)?.url ||
                context?.url
              }
              thumbnail={context?.thumbnail}
              title={title || context?.title || 'Video'}
            />
            {!!items.length && (
              <input
                type="checkbox"
                className="te-preview-checkbox"
                aria-label={single ? `Select ${single.title}` : `Select all (${eligible.length})`}
                disabled={busy || !eligible.length}
                checked={!!eligible.length && eligible.every(item => item.selected)}
                onChange={event =>
                  void persistItems(
                    items.map(item => ({
                      ...item,
                      selected: item.available !== false && event.target.checked,
                    })),
                    context!.url
                  ).catch(report)
                }
              />
            )}
          </label>
          <div className="te-download-card-body">
            <h2 className="te-download-title" title={single?.title || title || context?.title}>
              {single?.title || title || context?.title || 'Connect to a video'}
            </h2>
            <div className="te-download-toolbar">
              {preferences.video && (
                <select
                  className="te-select te-quality-picker"
                  aria-label="Video quality"
                  value={`${preferences.format || 'auto'}:${preferences.maxHeight || 0}`}
                  disabled={busy || settingsLocked || qualityLoading}
                  onChange={event => {
                    const [format, height] = event.target.value.split(':');
                    void changePreferences({
                      ...preferences,
                      format: format === 'auto' ? undefined : (format as 'mp4' | 'webm'),
                      maxHeight: Number(height) || undefined,
                    });
                  }}
                >
                  <option value="auto:0">Auto quality</option>
                  {renditions.map(item => (
                    <option
                      key={`${item.format}:${item.height}`}
                      value={`${item.format}:${item.height}`}
                    >
                      {item.format.toUpperCase()} · {item.height ? `${item.height}p` : 'Source'}
                    </option>
                  ))}
                  {(preferences.format || preferences.maxHeight) &&
                    !renditions.some(
                      item =>
                        item.format === preferences.format &&
                        item.height === (preferences.maxHeight || 0)
                    ) && (
                      <option
                        value={`${preferences.format || 'auto'}:${preferences.maxHeight || 0}`}
                      >
                        {preferences.format?.toUpperCase() || 'Auto'} ·{' '}
                        {preferences.maxHeight ? `≤${preferences.maxHeight}p` : 'Source'}
                      </option>
                    )}
                </select>
              )}
              <button
                className="te-btn-primary te-download-button"
                disabled={
                  busy ||
                  qualityLoading ||
                  !context ||
                  !validChoice ||
                  !items.some(
                    item =>
                      item.selected && item.status !== 'completed' && item.status !== 'skipped'
                  )
                }
                onClick={() => void runQueue()}
              >
                <Download size={15} />
                Download
              </button>
            </div>
            {single && renderStatus(single)}
            <p className="te-muted te-card-status">
              {items.filter(item => item.selected).length} selected ·{' '}
              {preferences.video && (
                <>
                  {counts.video}/{counts.total} videos saved
                </>
              )}
              {preferences.video && preferences.transcript && ' · '}
              {preferences.transcript && (
                <>
                  {counts.transcript}/{counts.total} transcripts saved
                </>
              )}
            </p>
          </div>
        </div>
        {preferences.video && context?.sources.length && !renditions.length ? (
          <button
            type="button"
            className="te-text-button"
            disabled={busy || settingsLocked || qualityLoading}
            onClick={() => {
              const abort = new AbortController();
              qualityController.current = abort;
              setQualityLoading(true);
              void inspectVideo(context, abort.signal, true)
                .then(value => {
                  if (!abort.signal.aborted) setRenditions(value);
                })
                .catch(err => {
                  if (!abort.signal.aborted) setQualityNotice(errorText(err));
                })
                .finally(() => {
                  if (!abort.signal.aborted) setQualityLoading(false);
                });
            }}
          >
            {qualityLoading ? 'Reading qualities…' : 'Detect available qualities'}
          </button>
        ) : null}
        {qualityNotice && <p className="te-muted text-xs">{qualityNotice}</p>}
        {listSize && listSize.expected !== listSize.unique && (
          <p className="te-muted text-sm">
            {listSize.loaded}/{listSize.expected} playlist entries loaded · {listSize.unique} unique
            items
          </p>
        )}
        {(incomplete || listFailed) && (
          <div className="flex flex-col gap-2">
            <p className="te-muted text-sm" role="status">
              The full list is not loaded. You can download the selected items now or retry the
              list.
            </p>
            <button className="te-btn" disabled={busy} onClick={() => void loadItems()}>
              {listFailed ? 'Retry video list' : 'Load remaining items'}
            </button>
          </div>
        )}
        {items.length > 1 && (
          <details className="te-item-details">
            <summary>Videos ({items.length})</summary>
            <div className="flex flex-col gap-3 mt-2">
              <ul className="flex flex-col">
                {items.map((item, index) => (
                  <li key={item.id} className="py-2">
                    {item.section && (index === 0 || items[index - 1].section !== item.section) && (
                      <h3 className="font-semibold mb-3">{item.section}</h3>
                    )}
                    <div className="te-item-row">
                      <label className="te-preview-selection">
                        <Preview
                          url={item.url}
                          thumbnail={item.url === context?.url ? context?.thumbnail : undefined}
                          title={item.title}
                        />
                        <input
                          className="te-preview-checkbox"
                          aria-label={`Select ${item.title}`}
                          type="checkbox"
                          disabled={busy || item.available === false}
                          checked={item.selected}
                          onChange={e =>
                            void persistItems(
                              items.map(value =>
                                value.id === item.id
                                  ? { ...value, selected: e.target.checked }
                                  : value
                              ),
                              context!.url
                            ).catch(report)
                          }
                        />
                      </label>
                      <div className="te-item-copy">
                        <span className="te-item-title">{item.title}</span>
                        {renderStatus(item)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        )}
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
              <li key={host}>{host.replace(/^https:\/\//, '').replace(/\/\*$/, '')}</li>
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
