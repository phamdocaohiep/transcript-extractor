const key = 'download_diagnostics_v1';
const limit = 1000;
const events = new Set([
  'run_started',
  'run_finished',
  'run_paused',
  'item_result',
  'discovery',
  'plan_ready',
  'permission_needed',
  'permission_requested',
  'permission_result',
  'directory_result',
  'request_started',
  'request_finished',
  'request_failed',
  'transcript_failed',
  'retry',
  'file_saved',
  'list_loaded',
  'selection_failed',
]);
type EventName =
  | 'run_started'
  | 'run_finished'
  | 'run_paused'
  | 'item_result'
  | 'discovery'
  | 'plan_ready'
  | 'permission_needed'
  | 'permission_requested'
  | 'permission_result'
  | 'directory_result'
  | 'request_started'
  | 'request_finished'
  | 'request_failed'
  | 'transcript_failed'
  | 'retry'
  | 'file_saved'
  | 'list_loaded'
  | 'selection_failed';
interface Fields {
  fallbackAvailable?: boolean;
  videoCount?: number;
  audioCount?: number;
  tab?: number;
  mode?: 'manual' | 'automatic' | 'list';
  source?: 'youtube' | 'udemy' | 'other';
  protocol?: 'sabr' | 'hls' | 'tracks' | 'file';
  result?: 'completed' | 'partial' | 'failed' | 'skipped' | 'cancelled';
  format?: 'video' | 'transcript' | 'audio';
  extension?: 'mp4' | 'webm' | 'md' | 'm4a' | 'mp3';
  permission?: 'host' | 'directory';
  origin?: string;
  origins?: string[];
  code?: string;
  video?: boolean;
  transcript?: boolean;
  automatic?: boolean;
  player?: boolean;
  loading?: boolean;
  adaptive?: boolean;
  configured?: boolean;
  granted?: boolean;
  item?: number;
  total?: number;
  status?: number;
  elapsedMs?: number;
  directCount?: number;
  formatCount?: number;
  videoFormat?: number;
  audioFormat?: number;
  height?: number;
  duration?: number;
  bytes?: number;
  loadedCount?: number;
  expectedCount?: number;
  uniqueCount?: number;
}
export type Trace = (event: EventName, fields?: Fields) => void;
interface Entry {
  at: number;
  run: string;
  event: EventName;
  fields: Fields;
}
let pending = Promise.resolve();
let writeFailures = 0;
const originPattern = /^https:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d+)?\/\*$/i;
const numberFields = new Set([
  'videoCount',
  'audioCount',
  'tab',
  'item',
  'total',
  'status',
  'elapsedMs',
  'directCount',
  'formatCount',
  'videoFormat',
  'audioFormat',
  'height',
  'duration',
  'bytes',
  'loadedCount',
  'expectedCount',
  'uniqueCount',
]);
const booleanFields = new Set([
  'fallbackAvailable',
  'video',
  'transcript',
  'automatic',
  'player',
  'loading',
  'adaptive',
  'configured',
  'granted',
]);
const choices: Record<string, string[]> = {
  mode: ['manual', 'automatic', 'list'],
  source: ['youtube', 'udemy', 'other'],
  protocol: ['sabr', 'hls', 'tracks', 'file'],
  result: ['completed', 'partial', 'failed', 'skipped', 'cancelled'],
  format: ['video', 'transcript', 'audio'],
  extension: ['mp4', 'webm', 'md', 'm4a', 'mp3'],
  permission: ['host', 'directory'],
};

/** Allowlisted scalar data only: no messages, URLs, headers, tokens, paths or titles. */
function sanitize(fields: Fields): Fields {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields || {})) {
    if (numberFields.has(name) && typeof value === 'number' && Number.isFinite(value) && value >= 0)
      result[name] = value;
    else if (booleanFields.has(name) && typeof value === 'boolean') result[name] = value;
    else if (
      typeof value === 'string' &&
      Object.prototype.hasOwnProperty.call(choices, name) &&
      choices[name].includes(value)
    )
      result[name] = value;
    else if (
      name === 'code' &&
      typeof value === 'string' &&
      /^(host_access|aborted|http_[1-5]\d\d|timeout|transcript_unavailable|network|storage|unsupported|unknown)$/.test(
        value
      )
    )
      result[name] = value;
    else if (
      name === 'origin' &&
      typeof value === 'string' &&
      originPattern.test(value) &&
      value.length < 200
    )
      result[name] = value;
    else if (name === 'origins' && Array.isArray(value))
      result[name] = value
        .filter(item => typeof item === 'string' && item.length < 200 && originPattern.test(item))
        .slice(0, 16);
  }
  return result as Fields;
}

function readEntries(value: unknown): Entry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      entry =>
        entry &&
        events.has(entry.event) &&
        Number.isFinite(entry.at) &&
        typeof entry.run === 'string' &&
        /^[a-f0-9-]{36}$/i.test(entry.run)
    )
    .map(entry => ({
      at: entry.at,
      run: entry.run,
      event: entry.event,
      fields: sanitize(entry.fields),
    }));
}

function enqueue(operation: () => Promise<void>) {
  const operationResult = pending.then(async () => {
    if (navigator.locks?.request)
      await navigator.locks.request('download-diagnostics', { mode: 'exclusive' }, operation);
    else await operation();
  });
  pending = operationResult.catch(() => {
    writeFailures++;
  });
  return operationResult;
}

export function startRun(mode: 'manual' | 'automatic' | 'list', tab?: number): Trace {
  const run = crypto.randomUUID();
  const trace: Trace = (event, fields = {}) => {
    if (!events.has(event)) return;
    const entry: Entry = { at: Date.now(), run, event, fields: sanitize({ ...fields, tab }) };
    enqueue(async () => {
      const entries = readEntries((await chrome.storage.local.get(key))[key]);
      entries.push(entry);
      while (entries.length > limit) {
        const index = entries.findIndex(value =>
          ['request_started', 'request_finished', 'discovery'].includes(value.event)
        );
        entries.splice(index < 0 ? 0 : index, 1);
      }
      await chrome.storage.local.set({ [key]: entries });
    });
  };
  trace('run_started', { mode });
  return trace;
}

export function classifyError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted';
  const message = error instanceof Error ? error.message : '';
  const status = message.match(/HTTP ([1-5]\d\d)/)?.[1];
  if (status) return `http_${status}`;
  if (/allow access|host access/i.test(message)) return 'host_access';
  if (/transcript|caption/i.test(message)) return 'transcript_unavailable';
  if (/timeout|timed out/i.test(message)) return 'timeout';
  if (/quota|storage|disk|write|folder/i.test(message)) return 'storage';
  if (/unsupported|not supported|DRM/i.test(message)) return 'unsupported';
  if (error instanceof TypeError || /network|fetch|connect/i.test(message)) return 'network';
  return 'unknown';
}

export async function flushDiagnostics() {
  await pending;
}
export async function exportDiagnostics(): Promise<string> {
  await pending;
  return JSON.stringify(
    {
      schema: 1,
      version: chrome.runtime.getManifest?.().version || 'unknown',
      exportedAt: new Date().toISOString(),
      writeFailures,
      events: readEntries((await chrome.storage.local.get(key))[key]),
    },
    null,
    2
  );
}
export async function clearDiagnostics() {
  await enqueue(async () => {
    await chrome.storage.local.set({ [key]: [] });
    writeFailures = 0;
  });
}
