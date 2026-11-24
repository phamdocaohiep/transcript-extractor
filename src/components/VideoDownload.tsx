import { useEffect, useRef, useState } from 'react';
import type { VideoDownloadContext } from '../lib/hls-discovery';
import { PROTOCOL_VERSION } from '../lib/hls-discovery';
import { Trash2, X, Download, FolderOpen, Pencil } from 'lucide-react';
import { Preview } from './Preview';
import { deleteSaved, revealSaved } from '../lib/saved-files';
import {
  HostAccessNeeded,
  SelectionUnavailable,
  prepareVideo,
  saveDownload,
  completionKey,
  inspectVideo,
  type DownloadPlan,
  type Rendition,
} from '../lib/download';
import { lectureId } from '../lib/collection';
import { loadCourseCollection } from '../lib/collection-store';
import { groupKey } from '../lib/identity';
import { resolvePlayback, canRetryDownload } from '../lib/playback';
import { readStreams, selectStreams } from '../lib/stream-discovery';
import { loadPreferences, savePreferences } from '../lib/preferences';
import type { DownloadItem, Preferences, SavedFiles } from '../lib/download-types';
import { selectionKey, requiredFiles } from '../lib/download-types';
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
  transferring?: boolean;
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
  sourceClosed = false,
}: {
  sourceTabId?: number;
  screen?: 'main' | 'settings';
  onBusyChange?: (busy: boolean) => void;
  active?: boolean;
  settingsLocked?: boolean;
  onStateChange?: (tabId: number, state: QueueState) => void;
  onClose?: () => void;
  sourceClosed?: boolean;
} = {}) {
  const tabId = sourceTabId ?? Number(new URLSearchParams(location.search).get('tab'));

  const [context, setContext] = useState<VideoDownloadContext | null>(null);
  const [source, setSource] = useState('');
  const [title, setTitle] = useState('');
  const [preferences, setPreferences] = useState<Preferences>({
    video: true,
    transcript: true,
    automatic: false,
  });
  const [loaded, setLoaded] = useState(false);
  const [items, setItems] = useState<DownloadItem[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [editing, setEditing] = useState<string>();
  const [locationBusy, setLocationBusy] = useState(false);
  const [locationNotice, setLocationNotice] = useState('');
  const [listSize, setListSize] = useState<{
    loaded: number;
    expected: number;
    unique: number;
  } | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [listNotice, setListNotice] = useState('');
  const [renditions, setRenditions] = useState<Rendition[]>([]);
  const [qualityNotice, setQualityNotice] = useState('');
  const [qualityLoading, setQualityLoading] = useState(false);
  const qualityController = useRef<AbortController | null>(null);
  const removed = useRef(new Set<string>());
  const resetSelection = useRef(false);
  const listedGroup = useRef('');
  useEffect(() => {
    if (!context || !preferences.video || sourceClosed) return;
    const abort = new AbortController();
    qualityController.current?.abort();
    qualityController.current = abort;
    setRenditions([]);
    setQualityNotice('');
    setQualityLoading(false);
    void loadRenditions(context, abort.signal)
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
    // Discovery reads fresh snapshots without changing the queue's source context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, preferences.video, sourceClosed]);
  const [busy, setBusy] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const closed = useRef(sourceClosed);
  closed.current = sourceClosed;
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
      transferring,
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
    transferring,
  ]);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  const working = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const automaticAttempt = useRef('');
  useEffect(() => {
    const changed = (event: Event) => {
      const url = (event as CustomEvent<string>).detail;
      if (typeof url !== 'string') return;
      const id = lectureId(url, '');
      if (!itemsRef.current.some(item => item.url && lectureId(item.url, '') === id)) return;
      const value = settings.current;
      automaticAttempt.current = `${id}:${value.video}:${value.transcript}:${selectionKey(value)}:${!!value.audio}:${value.materials !== false}`;
      setItems(previous =>
        previous.map(item =>
          item.url && lectureId(item.url, '') === id
            ? {
                ...item,
                status: 'pending',
                saved: { video: false, transcript: false },
                error: undefined,
              }
            : item
        )
      );
    };
    window.addEventListener('download-files-deleted', changed);
    return () => window.removeEventListener('download-files-deleted', changed);
  }, []);
  const resumeQueue = useRef(false);
  const requesting = useRef(false);
  const continueQueue = useRef<() => Promise<void>>(async () => undefined);
  const accessDialog = useRef<HTMLDialogElement>(null);
  const restartDialog = useRef<HTMLDialogElement>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  useEffect(() => {
    const dialog = restartDialog.current;
    if (!dialog) return;
    if (active && confirmRestart && !dialog.open) dialog.showModal();
    else if ((!active || !confirmRestart) && dialog.open) dialog.close();
  }, [active, confirmRestart]);
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
        'The page is running an older extension script. Reload the source page manually or enable automatic reload in Settings.'
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
  async function loadRenditions(
    initial: VideoDownloadContext,
    signal: AbortSignal,
    readManifest = false
  ): Promise<Rendition[]> {
    if (initial.protected || initial.kind === 'quiz' || initial.kind === 'article') return [];
    let current = initial;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      if (closed.current) return [];
      try {
        if (attempt) {
          // Never reload or navigate a source while its download owns the tab.
          if (working.current) return [];
          current = await pageContext();
          signal.throwIfAborted();
          if (working.current || closed.current) return [];
          if (lectureId(current.url, '') !== lectureId(initial.url, '')) return [];
          if (attempt === 2 && readManifest && settings.current.reload) {
            await chrome.tabs.reload(tabId);
            current = await waitForContext(signal, initial.url);
          }
          signal.throwIfAborted();
          if (lectureId(current.url, '') !== lectureId(initial.url, '')) return [];
        }
        const value = await inspectVideo(current, signal, readManifest);
        if (value.length) return value;
        // HLS manifests are fetched only through the explicit Detect action.
        if (!readManifest && !current.streams && !current.adaptive) return [];
      } catch (err) {
        signal.throwIfAborted();
        if (attempt === 2) throw err;
      }
      if (attempt < 2) await sleep(signal);
    }
    return [];
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
        if (
          !(err instanceof PageConnectionError) ||
          reloadPage ||
          !settings.current.reload ||
          closed.current
        )
          throw err;
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
      if (!(err instanceof PageConnectionError) || !settings.current.reload || closed.current)
        throw err;
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
        if (disposed) return;
        setPreferences(value);
        settings.current = value;
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
      if (id !== tabId || (info.status !== 'complete' && !info.url) || working.current) return;
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
      resetSelection.current = false;
      setPreferences(value);
      settings.current = value;
      if (
        value.video !== preferences.video ||
        value.transcript !== preferences.transcript ||
        selectionKey(value) !== selectionKey(preferences) ||
        value.audio !== preferences.audio ||
        value.materials !== preferences.materials
      ) {
        setItems([]);
        removed.current.clear();
      }
      automaticAttempt.current = '';
      if (value.reload && !preferences.reload && !context && !closed.current) await refresh();
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
    let nextPlan: DownloadPlan | null = null;
    try {
      nextPlan =
        includeVideo &&
        preferences.audio &&
        !next.sources.length &&
        !next.streams?.length &&
        !next.adaptive &&
        next.audioSources?.length
          ? { kind: 'audio-file', url: next.audioSources[0], extension: 'm4a' }
          : includeVideo
            ? await prepareVideo(
                selected,
                signal,
                next.streams,
                next.adaptive,
                trace.current,
                preferences
              )
            : null;
    } catch (err) {
      if (err instanceof SelectionUnavailable) resetSelection.current = true;
      throw err;
    }
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
    if (
      !includeVideo ||
      (next.audioSources?.length && !next.sources.length && !next.streams?.length && !next.adaptive)
    )
      return next;
    return resolvePlayback(
      next.url,
      pageContext,
      () => chrome.tabs.reload(tabId),
      signal,
      () => {
        trace.current('retry');
        setNotice('Reloading the page and retrying the video…');
      },
      !!preferences.reload && !closed.current
    );
  }
  async function savePrepared(...args: Parameters<typeof saveDownload>) {
    setTransferring(true);
    try {
      const item = itemsRef.current.find(
        item => item.url && lectureId(item.url, '') === lectureId(args[0].url, '')
      );
      const sequence = item?.sequence || (item ? itemsRef.current.indexOf(item) + 1 : 1);
      args[8] = `${String(sequence).padStart(3, '0')} - ${item?.filename?.trim() || args[0].title}`;
      args[9] = [
        title || args[0].title,
        ...(item?.parent ? [item.parent] : []),
        item?.section || 'Videos',
      ];
      return await saveDownload(...args);
    } finally {
      setTransferring(false);
    }
  }
  async function saveWithRetry(
    next: VideoDownloadContext,
    signal: AbortSignal,
    saved: SavedFiles = { video: false, transcript: false }
  ) {
    const requested = requiredFiles(
      /(^|\.)coursera\.org$/.test(new URL(next.url).hostname) ? next : {},
      preferences
    );
    const choice = {
      ...preferences,
      video: requested.video && !saved.video,
      transcript: requested.transcript && !saved.transcript,
      audio: requested.audio && !saved.audio,
    };
    let missingVideo = false;
    if (
      choice.audio &&
      next.audioSources?.length &&
      !next.sources.length &&
      !next.streams?.length &&
      !next.adaptive
    ) {
      missingVideo = choice.video;
      choice.video = false;
    }
    let current = next;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        current = await recover(current, signal, choice.video || choice.audio);
        if (
          (choice.video || choice.audio) &&
          current.hasPlayer === false &&
          !current.audioSources?.length &&
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
          await savePrepared(
            current,
            null,
            result.text,
            { ...choice, video: false, audio: false },
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
          choice.video || choice.audio,
          choice.transcript,
          saved.video || !!saved.audio
        );
        const actual = { ...choice, transcript: choice.transcript && !!result.text.trim() };
        const output =
          actual.video || actual.audio || actual.transcript
            ? await savePrepared(
                current,
                result.plan,
                result.text,
                actual,
                signal,
                (completed, total, bytes) => setProgress({ completed, total, bytes }),
                setNotice,
                trace.current
              )
            : undefined;
        const warning = [
          result.warning,
          output?.warning,
          missingVideo ? 'This item exposes audio only; video is unavailable.' : '',
        ]
          .filter(Boolean)
          .join(' ');
        setContext(current);
        if (result.warning) setNotice(result.warning);
        return {
          status: warning ? ('partial' as const) : ('completed' as const),
          warning,
          saved: {
            video: saved.video || actual.video,
            transcript: saved.transcript || actual.transcript,
            ...(requested.audio || saved.audio
              ? { audio: saved.audio || output?.audioSaved === true }
              : {}),
          },
        };
      } catch (err) {
        if (attempt || !canRetryDownload(err) || !preferences.reload || closed.current) throw err;
        signal.throwIfAborted();
        setNotice('Reloading the page and retrying the download…');
        trace.current('retry', { code: classifyError(err) });
        await chrome.tabs.reload(tabId);
        current = await waitForContext(signal, current.url);
      }
    }
    throw new Error('Download did not finish.');
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
  async function retry() {
    if (working.current || closed.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setItems([]);
    setProgress({ completed: 0, total: 0, bytes: 0 });
    resumeQueue.current = false;
    setHosts([]);
    const abort = new AbortController();
    controller.current = abort;
    try {
      if (resetSelection.current) {
        const value = { ...preferences, format: undefined, maxHeight: undefined };
        await savePreferences(value);
        settings.current = value;
        setPreferences(value);
        removed.current.clear();
        resetSelection.current = false;
      }
      if (settings.current.reload) await chrome.tabs.reload(tabId);
      const current = settings.current.reload
        ? await waitForContext(abort.signal)
        : await pageContext();
      setContext(current);
      setSource(current.sources[0] || '');
      loadedList.current = '';
      // Retry reconnects and resets the row; only Download starts another transfer.
      automaticAttempt.current = `${lectureId(current.url, '')}:${settings.current.video}:${settings.current.transcript}:${selectionKey(settings.current)}:${!!settings.current.audio}:${settings.current.materials !== false}`;
    } catch (err) {
      report(err);
    } finally {
      working.current = false;
      setBusy(false);
      controller.current = null;
    }
  }
  const legacyQueueKey = (url: string) =>
    `download_queue:${groupKey(url)}:${preferences.video}:${preferences.transcript}${preferences.format || preferences.maxHeight ? `:quality:${selectionKey(preferences)}` : ''}${preferences.audio ? ':audio:true' : ''}${preferences.materials === false ? ':materials:false' : ''}`;
  const queueKey = (url: string) => `${legacyQueueKey(url)}:tab:${tabId}`;
  async function persistItems(value: DownloadItem[], url: string) {
    listedGroup.current = groupKey(url);
    if (value.length === 1 && value[0].available !== false)
      value = [{ ...value[0], selected: true }];
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
      const current = await pageContext();
      if (listedGroup.current && listedGroup.current !== groupKey(current.url)) {
        resetSelection.current = false;
        setItems([]);
      }
      setContext(current);
      const response = await send('GET_DOWNLOAD_ITEMS');
      abort.signal.throwIfAborted();
      if (!response?.success) throw new Error(response?.error || 'Could not load the item list.');
      if (response.data?.sourceUrl && groupKey(response.data.sourceUrl) !== groupKey(current.url))
        throw new Error('The source changed while reading its videos. Retry to reconnect.');
      loadedList.current = `${groupKey(current.url)}:${preferences.video}:${preferences.transcript}:${selectionKey(preferences)}:${!!preferences.audio}:${preferences.materials !== false}`;
      setContext(current);
      setTitle(response.data?.title || current.title);
      setListNotice(typeof response.data?.notice === 'string' ? response.data.notice : '');
      const sections = Array.isArray(response.data?.sections) ? response.data.sections : [];
      const keys = sections.flatMap((section: { lectures?: Array<{ url?: string }> }) =>
        (section.lectures || []).flatMap(item =>
          item.url ? [completionKey(item.url), completionKey(item.url, preferences)] : []
        )
      );
      const completedFiles = keys.length ? await chrome.storage.local.get(keys) : {};
      const storedQueues = await chrome.storage.local.get([
        queueKey(current.url),
        legacyQueueKey(current.url),
      ]);
      const stored = (storedQueues[queueKey(current.url)] ??
        storedQueues[legacyQueueKey(current.url)]) as DownloadItem[] | undefined;
      const seen = new Set<string>();
      const next: DownloadItem[] = [];
      let sequence = 0;
      for (const section of sections) {
        for (const item of section.lectures ?? []) {
          sequence++;
          if (item.kind === 'quiz' || item.kind === 'article') {
            if (
              !/(^|\.)coursera\.org$/.test(new URL(current.url).hostname) ||
              preferences.materials === false
            )
              continue;
          }
          if (
            item.kind !== 'article' &&
            item.kind !== 'quiz' &&
            !preferences.video &&
            !preferences.audio &&
            !preferences.transcript
          )
            continue;
          if (!item.id || seen.has(item.id)) continue;
          seen.add(item.id);
          const previous = stored?.find(value => value.id === item.id);
          const previousFiles = previous
            ? getSaved(previous, preferences)
            : { video: false, transcript: false };
          const completed = item.url
            ? (completedFiles[completionKey(item.url, preferences)] as
                | Partial<SavedFiles>
                | undefined)
            : undefined;
          const shared = item.url
            ? (completedFiles[completionKey(item.url)] as { transcript?: boolean } | undefined)
            : undefined;
          const saved = {
            video: previousFiles.video || completed?.video === true,
            ...(preferences.audio || previousFiles.audio || completed?.audio
              ? { audio: previousFiles.audio || completed?.audio === true }
              : {}),
            transcript:
              previousFiles.transcript ||
              completed?.transcript === true ||
              shared?.transcript === true,
          };
          const required = requiredFiles(item, preferences);
          const complete =
            (!required.video || saved.video) &&
            (!required.transcript || saved.transcript) &&
            (!required.audio || saved.audio);
          const partial = !complete && (saved.video || saved.transcript || saved.audio);
          next.push({
            id: item.id,
            ...(item.kind ? { kind: item.kind } : {}),
            filename: previous?.filename,
            title: item.title || 'Untitled',
            section: section.title,
            parent: item.parent || section.parent,
            sequence: item.sequence || sequence,
            url: item.url,
            selected: item.available !== false && previous?.selected !== false,
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
      if (!next.length && /(^|\.)udemy\.com$/.test(new URL(current.url).hostname)) {
        setListFailed(true);
        if (
          !current.hasPlayer &&
          !current.sources.length &&
          !current.streams?.length &&
          !current.adaptive
        )
          throw new Error('The video list is not ready. Open Course content and retry the list.');
        setError(
          'Only the current video is available. Retry the list to load the remaining videos.'
        );
      }
      if (!next.length && /(^|\.)coursera\.org$/.test(new URL(current.url).hostname))
        throw new Error(
          'No requested items were discovered. Open the course outline and retry the list.'
        );
      if (!next.length) {
        const key = completionKey(current.url, preferences);
        const base = completionKey(current.url);
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
          id: lectureId(current.url, ''),
          title: current.title,
          url: current.url,
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
        item => !removed.current.has(`${groupKey(current.url)}:${item.id}`)
      );
      await persistItems(visibleItems, current.url);
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
  function startQueue() {
    if (working.current || sourceClosed) return;
    if (
      items.some(item => item.selected && item.available !== false && item.status === 'completed')
    )
      setConfirmRestart(true);
    else void runQueue();
  }
  async function runQueue(resume = false, restart = false) {
    if (working.current || !context) return;
    working.current = true;
    if (!resume) trace.current = startRun('manual', tabId);
    trace.current('discovery', {
      video: preferences.video,
      transcript: preferences.transcript,
      automatic: preferences.automatic,
    });
    setBusy(true);
    setError('');
    const abort = new AbortController();
    controller.current = abort;
    const root = context.url;
    const next = items.map(item =>
      restart && item.selected && item.available !== false && item.status !== 'skipped'
        ? {
            ...item,
            status: 'pending' as const,
            saved: { video: false, transcript: false, audio: false },
            error: undefined,
          }
        : { ...item }
    );
    try {
      const batch = (await chrome.storage.local.get('course_batch_state')).course_batch_state as
        | { isActive?: boolean; isPaused?: boolean }
        | undefined;
      if (batch?.isActive && !batch.isPaused)
        throw new Error('Pause transcript collection before starting video downloads.');
      await navigator.locks.request(`download-${tabId}`, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('Another download window is using this tab.');
        for (const item of next) {
          if (closed.current) break;
          if (!item.selected || item.status === 'completed' || item.status === 'skipped') continue;
          abort.signal.throwIfAborted();
          item.status = 'downloading';
          item.error = undefined;
          await persistItems([...next], root);
          try {
            let current = await connect(abort.signal);
            abort.signal.throwIfAborted();
            if (closed.current) break;
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
            automaticAttempt.current = `${lectureId(current.url, '')}:${preferences.video}:${preferences.transcript}:${selectionKey(preferences)}:${!!preferences.audio}:${preferences.materials !== false}`;
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
          `Finished: ${counts.saved} saved, ${counts.partial ? `${counts.partial} ${preferences.audio || /(^|\.)coursera\.org$/.test(new URL(root).hostname) ? 'partially saved' : 'video saved without transcript'}, ` : ''}${counts.skipped} without video, ${counts.failed} failed.`
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
      if (next.some(item => item.selected && item.status === 'completed')) {
        for (const item of next) {
          if (item.status === 'completed') item.selected = false;
        }
        await persistItems(next, root).catch(report);
      }
      working.current = false;
      setBusy(false);
      controller.current = null;
    }
  }
  const loadedList = useRef('');
  useEffect(() => {
    if (!loaded || busy || !context) return;
    const key = `${groupKey(context.url)}:${preferences.video}:${preferences.transcript}:${selectionKey(preferences)}:${!!preferences.audio}:${preferences.materials !== false}`;
    if (loadedList.current === key) return;
    loadedList.current = key;
    void loadItems();
  });

  // A persistent download tab watches the source tab while automatic downloading is enabled.
  useEffect(() => {
    if (
      !loaded ||
      confirmRestart ||
      !preferences.automatic ||
      (!preferences.video && !preferences.transcript && !preferences.audio)
    )
      return;
    const timer = setInterval(() => {
      if (working.current || closed.current) return;
      working.current = true;
      void (async () => {
        const abort = new AbortController();
        controller.current = abort;
        try {
          const next = await connect(abort.signal);
          const address = new URL(next.url);
          if (/(^|\.)youtube\.com$/.test(address.hostname) && address.pathname === '/playlist')
            return;
          if (
            (preferences.video || preferences.audio) &&
            !next.audioSources?.length &&
            (next.kind === 'video' || next.hasPlayer) &&
            !next.protected &&
            !next.sources.length &&
            !selectStreams(next.streams || []) &&
            !next.adaptive
          )
            return;
          const key = `${lectureId(next.url, '')}:${preferences.video}:${preferences.transcript}:${selectionKey(preferences)}:${!!preferences.audio}:${preferences.materials !== false}`;
          if (automaticAttempt.current === key) return;
          automaticAttempt.current = key;
          const marks = await chrome.storage.local.get([
            completionKey(next.url),
            completionKey(next.url, preferences),
          ]);
          const selected = marks[completionKey(next.url, preferences)] as
            | Partial<SavedFiles>
            | undefined;
          const shared = marks[completionKey(next.url)] as { transcript?: boolean } | undefined;
          const requested = requiredFiles(next, preferences);
          const completed = {
            audio: selected?.audio,
            video: selected?.video,
            transcript: selected?.transcript || shared?.transcript,
          };
          if (
            (!requested.video || completed?.video) &&
            (!requested.transcript || completed?.transcript) &&
            (!requested.audio || completed?.audio)
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
              ...(requested.audio ? { audio: completed.audio === true } : {}),
            });
            trace.current('item_result', {
              result: result.status,
              video: result.saved.video,
              transcript: result.saved.transcript,
            });
            const stored = (await chrome.storage.local.get(queueKey(next.url)))[
              queueKey(next.url)
            ] as DownloadItem[] | undefined;
            const id = lectureId(next.url, '');
            const rows = stored?.length
              ? stored
              : [
                  {
                    id,
                    url: next.url,
                    title: next.title,
                    selected: true,
                    status: 'pending' as const,
                  },
                ];
            await persistItems(
              rows.map(item =>
                (item.url && lectureId(item.url, '') === id) || item.id === id
                  ? {
                      ...item,
                      status: result.status,
                      selected: result.status === 'completed' ? false : item.selected,
                      saved: result.saved,
                      error: result.warning || undefined,
                    }
                  : item
              ),
              next.url
            );
            trace.current('run_finished', {
              result: result.status,
              video: result.saved.video,
              transcript: result.saved.transcript,
            });
          });
          setContext(next);
          setSource(next.sources[0] || '');
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
  }, [loaded, preferences, confirmRestart]);

  const archive = /(^|\.)coursera\.org$/.test(
    new URL(context?.url || 'https://example.test').hostname
  );
  const validChoice =
    preferences.video ||
    preferences.transcript ||
    preferences.audio ||
    (archive && preferences.materials !== false);
  const incomplete = !!listSize && listSize.loaded < listSize.expected;
  const eligible = items.filter(item => item.available !== false);
  const single = items.length === 1 ? items[0] : undefined;
  const downloaded = single
    ? single.kind === 'article' || single.kind === 'quiz'
      ? getSaved(single, preferences).transcript
      : preferences.audio && !getSaved(single, preferences).audio
        ? false
        : preferences.video
          ? getSaved(single, preferences).video
          : preferences.audio
            ? !!getSaved(single, preferences).audio
            : getSaved(single, preferences).transcript
    : false;
  const selectedItems = items.filter(item => item.selected);
  const pendingItems = selectedItems.filter(
    item => item.available !== false && item.status !== 'completed' && item.status !== 'skipped'
  );
  function renderDownload() {
    return (
      <button
        type="button"
        className="te-btn-primary te-download-button"
        disabled={
          busy ||
          qualityLoading ||
          sourceClosed ||
          !context ||
          !validChoice ||
          !selectedItems.some(item => item.available !== false && item.status !== 'skipped')
        }
        onClick={startQueue}
      >
        <Download size={15} />
        Download
      </button>
    );
  }
  function renderRetry() {
    return (
      <button
        type="button"
        className="te-text-button te-retry-button"
        disabled={busy || sourceClosed}
        onClick={() => void retry()}
      >
        Retry
      </button>
    );
  }
  async function removeSaved(item: DownloadItem) {
    if (working.current || busy || settingsLocked || !item.url || !context) return;
    if (
      !preferences.deleteFiles &&
      !window.confirm(
        'Delete this video and all its downloaded files, including transcripts and other saved qualities? This cannot be undone.'
      )
    )
      return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await deleteSaved(item.url);
      window.dispatchEvent(new CustomEvent('download-files-deleted', { detail: item.url }));
      await persistItems(
        items.map(value =>
          value.id === item.id
            ? {
                ...value,
                selected: true,
                status: 'pending',
                error: undefined,
                saved: { video: false, transcript: false },
              }
            : value
        ),
        context.url
      );
      setNotice(
        result.filesRecorded
          ? ''
          : 'Ready to download again. Older files were not deleted because their filenames were not recorded; remove those files manually.'
      );
      setProgress({ completed: 0, total: 0, bytes: 0 });
      automaticAttempt.current = `${lectureId(item.url, '')}:${preferences.video}:${preferences.transcript}:${selectionKey(preferences)}:${!!preferences.audio}:${preferences.materials !== false}`;
    } catch (err) {
      report(err);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  function renderStatus(item: DownloadItem, compact = false, detailsOnly = false) {
    const saved = getSaved(item, preferences);
    const showLabel = !detailsOnly || (compact && (saved.video || saved.transcript || saved.audio));
    if (!showLabel && !item.error && !saved.video && !saved.transcript && !saved.audio) return null;
    const label = compact
      ? saved.video
        ? saved.transcript
          ? saved.audio
            ? '1 video, audio & transcript downloaded'
            : '1 video & transcript downloaded'
          : saved.audio
            ? '1 video & audio / no transcript downloaded'
            : '1 video / no transcript downloaded'
        : saved.audio
          ? saved.transcript
            ? '1 audio & transcript downloaded'
            : '1 audio downloaded'
          : saved.transcript
            ? '1 transcript downloaded'
            : item.status === 'pending'
              ? 'Ready'
              : item.status
      : item.status === 'partial'
        ? 'Partially saved'
        : item.status;
    return (
      <div className="te-item-status">
        {showLabel && (
          <span className="te-muted text-sm" title={item.error}>
            {' '}
            {compact ? '' : '— '}
            {label}
          </span>
        )}
        {(getSaved(item, preferences).video ||
          getSaved(item, preferences).transcript ||
          getSaved(item, preferences).audio) && (
          <>
            <button
              className="te-small-button"
              type="button"
              aria-label={`Remove downloaded item: ${item.title}`}
              title="Delete video and downloaded resources"
              disabled={busy || settingsLocked}
              onClick={() => void removeSaved(item)}
            >
              <Trash2 size={14} />
            </button>
          </>
        )}
        {item.error && (!compact || !saved.video || (preferences.audio && !saved.audio)) && (
          <span className="te-muted text-sm">
            {showLabel ? ' · ' : ''}
            {item.error}
          </span>
        )}
        {compact && item.status === 'failed' && !saved.video && renderRetry()}
      </div>
    );
  }
  function renderFilename(item: DownloadItem) {
    return (
      <div className="te-filename-control">
        {editing === item.id ? (
          <input
            autoFocus
            aria-label={`Save as filename: ${item.title}`}
            className="te-filename-input"
            value={item.filename ?? item.title}
            disabled={busy}
            onChange={event =>
              void persistItems(
                items.map(value =>
                  value.id === item.id ? { ...value, filename: event.target.value } : value
                ),
                context!.url
              )
            }
            onBlur={() => setEditing(undefined)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === 'Escape') setEditing(undefined);
            }}
          />
        ) : (
          <button
            type="button"
            className="te-text-button"
            aria-label={`Edit filename: ${item.title}`}
            disabled={busy}
            onClick={() => setEditing(item.id)}
          >
            <Pencil size={12} />
            {item.filename || 'Save as'}
          </button>
        )}
      </div>
    );
  }
  function renderCancel(compact = false) {
    return (
      <button
        type="button"
        className={`${compact ? 'te-text-button' : 'te-btn'} te-cancel-button`}
        title="Cancel download"
        aria-label="Cancel download"
        onClick={() => controller.current?.abort()}
      >
        <X size={12} aria-hidden="true" />
        <span className={compact ? 'sr-only' : undefined}>Cancel</span>
      </button>
    );
  }
  function renderLocation(item: DownloadItem) {
    return (
      <button
        type="button"
        className="te-text-button te-location-button"
        aria-label="Open file location"
        title="Show in Finder"
        disabled={locationBusy}
        onClick={() =>
          void (async () => {
            setLocationBusy(true);
            setLocationNotice('');
            try {
              const result = await revealSaved(item.url || context!.url, preferences);
              if (!result.exact)
                setLocationNotice(
                  'Opened Chrome Downloads. This older file has no Chrome download record, so its original location is unknown.'
                );
            } catch (err) {
              setLocationNotice(errorText(err));
            } finally {
              setLocationBusy(false);
            }
          })()
        }
      >
        <FolderOpen size={14} />
      </button>
    );
  }
  function renderLabel(item: DownloadItem) {
    const label =
      item.status === 'pending'
        ? 'Ready'
        : item.status === 'partial'
          ? 'Completed'
          : item.status[0].toUpperCase() + item.status.slice(1);
    return (
      <div className="te-status-line">
        <span className="te-preview-status te-muted">{label}</span>
        {single && busy && renderCancel(true)}
        {(item.status === 'completed' || item.status === 'partial') && renderLocation(item)}
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
        {archive && (
          <label>
            <input
              type="checkbox"
              checked={preferences.materials !== false}
              disabled={busy || settingsLocked || !loaded}
              onChange={event =>
                void changePreferences({ ...preferences, materials: event.target.checked })
              }
            />{' '}
            Readings and visible practice/final-test questions (Markdown)
          </label>
        )}
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
            checked={preferences.audio === true}
            disabled={busy || settingsLocked || !loaded}
            onChange={event =>
              void changePreferences({ ...preferences, audio: event.target.checked })
            }
          />{' '}
          Audio file (M4A / MP3 / WebM)
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
            checked={!!preferences.reload}
            disabled={busy || settingsLocked || !loaded}
            onChange={event =>
              void changePreferences({ ...preferences, reload: event.target.checked })
            }
          />{' '}
          Automatically reload the source page to recover a download
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
        <label>
          <input
            type="checkbox"
            checked={preferences.deleteFiles === true}
            disabled={busy || settingsLocked || !loaded}
            onChange={event =>
              void changePreferences({ ...preferences, deleteFiles: event.target.checked })
            }
          />{' '}
          Delete video and all downloaded resources without asking
        </label>
        <p className="te-muted text-sm">
          Files save automatically to Chrome's default downloads folder.
        </p>
        <button
          type="button"
          className="te-text-button"
          onClick={() => chrome.downloads.showDefaultFolder()}
        >
          Open downloads folder
        </button>
        {!validChoice && <p role="alert">Choose video, audio or transcript.</p>}
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
          <div className="te-preview-column">
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
              {items.length > 1 && (
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
            {single && renderLabel(single)}
            {!single && (
              <div className="te-status-line">
                <span className="te-preview-status te-muted">
                  {error
                    ? 'Failed'
                    : busy
                      ? 'Downloading'
                      : counts.total > 0 && counts.saved === counts.total
                        ? 'Completed'
                        : 'Ready'}
                </span>
                {busy && renderCancel(true)}
              </div>
            )}
          </div>
          <div className="te-download-card-body">
            <h2 className="te-download-title" title={single?.title || title || context?.title}>
              {single?.title || title || context?.title || 'Connect to a video'}
            </h2>
            {single && single.status === 'pending' && !downloaded && renderFilename(single)}
            {!downloaded &&
              !sourceClosed &&
              single?.status !== 'failed' &&
              !!context &&
              !!items.length && (
                <div className="te-download-toolbar">
                  {preferences.video && single?.kind !== 'article' && single?.kind !== 'quiz' && (
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
                  {items.length === 1 && renderDownload()}
                </div>
              )}
            {single && renderStatus(single, true, true)}
            {single?.status === 'completed' && (
              <button
                type="button"
                className="te-text-button"
                disabled={busy || sourceClosed}
                onClick={startQueue}
              >
                Download again
              </button>
            )}
            {error && error !== single?.error && !(single && listFailed) && (
              <div className="te-item-status" role="alert">
                <span>Failed · {error}</span>
                {renderRetry()}
              </div>
            )}
            {items.length > 1 && (
              <p className="te-muted te-card-status">
                {items.filter(item => item.selected).length} selected ·{' '}
                {preferences.video && (
                  <>
                    {counts.video}/{counts.mediaTotal} videos saved
                  </>
                )}
                {preferences.audio && (
                  <>
                    {' '}
                    · {counts.audio}/{counts.mediaTotal} audio saved
                  </>
                )}
                {preferences.video && preferences.transcript && ' · '}
                {preferences.transcript && (
                  <>
                    {counts.transcript}/{counts.total} transcripts saved
                  </>
                )}
              </p>
            )}
          </div>
        </div>
        {listNotice && <p className="te-muted text-xs">{listNotice}</p>}
        {locationNotice && (
          <p role="status" className="te-muted text-xs">
            {locationNotice}
          </p>
        )}
        {!downloaded && (
          <div className="te-download-progress">
            {single?.status !== 'failed' && (progress.total > 0 || progress.bytes > 0) && (
              <>
                {progress.total > 0 && (
                  <progress
                    aria-label="Download progress"
                    className="w-full"
                    value={progress.completed}
                    max={progress.total}
                  />
                )}
                <span className="te-muted">
                  {progress.total ? `${progress.completed}/${progress.total} parts · ` : ''}
                  {(progress.bytes / 1048576).toFixed(1)} MB downloaded
                </span>
              </>
            )}
            {notice &&
              !(single && notice.startsWith('Finished:')) &&
              !/^Downloading\b/i.test(notice) && (
                <span role="status" className="te-muted">
                  {notice}
                </span>
              )}
          </div>
        )}
        {!downloaded &&
        single?.status !== 'failed' &&
        !sourceClosed &&
        preferences.video &&
        single?.kind !== 'article' &&
        single?.kind !== 'quiz' &&
        !!context &&
        !renditions.length ? (
          <button
            type="button"
            className="te-text-button"
            disabled={busy || settingsLocked || qualityLoading}
            onClick={() => {
              qualityController.current?.abort();
              const abort = new AbortController();
              qualityController.current = abort;
              setQualityLoading(true);
              void loadRenditions(context, abort.signal, true)
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
        {!downloaded && single?.status !== 'failed' && qualityNotice && (
          <p className="te-muted text-xs">{qualityNotice}</p>
        )}
        {items.length > 1 && listSize && listSize.expected !== listSize.unique && (
          <p className="te-muted text-sm">
            {listSize.loaded}/{listSize.expected} playlist entries loaded · {listSize.unique} unique
            items
          </p>
        )}
        {items.length > 1 && (incomplete || listFailed) && (
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
                      <div className="te-preview-column">
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
                        {renderLabel(item)}
                      </div>
                      <div className="te-item-copy">
                        <span className="te-item-title">{item.title}</span>
                        {!getSaved(item, preferences).video &&
                          item.status === 'pending' &&
                          renderFilename(item)}
                        {renderStatus(item, false, true)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        )}
        {(items.length > 1 || busy) && (
          <div className="te-selection-actions" aria-label="Selected downloads">
            {items.length > 1 ? (
              <span className="te-muted text-xs" role="status">
                {selectedItems.length} selected
                {!!selectedItems.length &&
                  !pendingItems.length &&
                  ' · Already downloaded or unavailable'}
              </span>
            ) : (
              <span className="te-muted text-xs">Downloading</span>
            )}
            {busy ? renderCancel() : renderDownload()}
          </div>
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
      <dialog
        ref={restartDialog}
        aria-labelledby="restart-title"
        className="te-glass fixed inset-0 m-auto max-w-[calc(100%-2rem)] w-96 p-5 backdrop:bg-black/60"
        style={{ background: 'var(--te-bg)', color: 'var(--te-text)' }}
        onCancel={() => setConfirmRestart(false)}
      >
        <div className="flex flex-col gap-4">
          <h2 id="restart-title" className="font-semibold">
            Download completed items again?
          </h2>
          <p>
            Some selected items are marked Completed. This uses saved status; files on disk are not
            checked.
          </p>
          <button
            className="te-btn-primary"
            disabled={busy || sourceClosed}
            onClick={() => {
              setConfirmRestart(false);
              void runQueue(false, true);
            }}
          >
            Download all again
          </button>
          <button
            className="te-btn"
            disabled={busy || sourceClosed}
            onClick={() => {
              setConfirmRestart(false);
              void runQueue();
            }}
          >
            Skip completed items
          </button>
          <button className="te-btn" onClick={() => setConfirmRestart(false)}>
            Cancel
          </button>
        </div>
      </dialog>
      {error && screen === 'settings' && (
        <p role="alert" className="te-note te-note--warn p-4">
          {error}
        </p>
      )}
    </main>
  );
}
