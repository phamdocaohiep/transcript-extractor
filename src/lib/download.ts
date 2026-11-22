import {
  hlsUrl,
  parseHls,
  readHlsResponse,
  resolveHls,
  safeVideoName,
  writeHls,
  type HlsPlan,
} from './hls';
import { probeMediaFile, writeMediaFile } from './media-file';
import { saveMp4 } from './mp4';
import { selectStreams, type StreamInfo } from './stream-discovery';
import { saveTracks, type TrackPlan } from './track-file';
import { selectAdaptive, saveAdaptive, type AdaptivePlan } from './adaptive-stream';
import type { AdaptiveInfo } from './playback-session';
import type { VideoDownloadContext } from './hls-discovery';
import type { Preferences } from './download-types';
import { selectionKey } from './download-types';
import { groupKey } from './identity';
import { assertEntitlement } from './subscription';
import { lectureId } from './collection';
import { classifyError, type Trace } from './diagnostics';
import { saveDirectory } from './preferences';

export const completionKey = (url: string, choice?: Pick<Preferences, 'format' | 'maxHeight'>) =>
  `download_completed:${lectureId(url, '')}${choice && (choice.format || choice.maxHeight) ? `:quality:${selectionKey(choice)}` : ''}`;
export function getFolderName(value: string) {
  const url = new URL(groupKey(value));
  const identifier =
    url.searchParams.get('list') ||
    url.searchParams.get('v') ||
    url.pathname.split('/').filter(Boolean).at(-1) ||
    'collection';
  return safeVideoName(`${url.hostname}_${identifier}`);
}

export class HostAccessNeeded extends Error {
  constructor(public origins: string[]) {
    super('Allow access to the video host, then retry.');
  }
}
export class SelectionUnavailable extends Error {
  constructor() {
    super('The saved quality is unavailable for this video. Retry will use Auto quality.');
  }
}

export type DownloadPlan =
  | HlsPlan
  | { kind: 'file'; url: string; extension: 'mp4' }
  | TrackPlan
  | AdaptivePlan;
export async function checkHosts(urls: string[], trace?: Trace) {
  const origins = [...new Set(urls.map(url => `${new URL(hlsUrl(url)).origin}/*`))];
  // Network access is approved at installation, including CDN hosts not known
  // beforehand. Query Chrome so deliberately withheld access is still respected.
  if (!origins.length || (await chrome.permissions.contains({ origins: ['https://*/*'] }))) return;
  const missing: string[] = [];
  const grants = new Map<string, boolean>();
  for (const origin of origins) {
    const hostname = new URL(origin).hostname;
    const domain = ['googlevideo.com', 'udemycdn.com'].find(
      value => hostname === value || hostname.endsWith(`.${value}`)
    );
    const family = domain ? `https://*.${domain}/*` : undefined;
    if (family) {
      if (!grants.has(family))
        grants.set(family, await chrome.permissions.contains({ origins: [family] }));
      if (grants.get(family)) continue;
    }
    if (!(await chrome.permissions.contains({ origins: [origin] }))) {
      // YouTube can move either track to another CDN hostname during playback.
      // Ask once for its video-server family, while preserving existing grants.
      const pattern = family || origin;
      if (!missing.includes(pattern)) missing.push(pattern);
    }
  }
  if (missing.length) {
    trace?.('permission_needed', { origins: missing });
    throw new HostAccessNeeded(missing);
  }
}
export async function fetchVideo(
  url: string,
  signal: AbortSignal,
  headers?: HeadersInit,
  options: RequestInit = {},
  trace?: Trace
) {
  await checkHosts([url], trace);
  const origin = `${new URL(url).origin}/*`;
  const started = Date.now();
  trace?.('request_started', { origin });
  // Signed URLs are used as supplied. Never synthesize auth headers or follow
  // redirects to an unapproved host.
  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.any([
        signal,
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(45_000),
      ]),
      headers,
      credentials: 'include',
      redirect: 'error',
    });
    trace?.('request_finished', {
      origin,
      status: response.status,
      elapsedMs: Date.now() - started,
    });
    return response;
  } catch (error) {
    trace?.('request_failed', {
      origin,
      code: classifyError(error),
      elapsedMs: Date.now() - started,
    });
    throw error;
  }
}

export async function prepareVideo(
  source: string,
  signal: AbortSignal,
  streams?: StreamInfo[],
  adaptive?: AdaptiveInfo,
  trace?: Trace,
  choice: Pick<Preferences, 'format' | 'maxHeight'> = {}
): Promise<DownloadPlan> {
  signal.throwIfAborted();
  if (streams?.length) {
    const selected = selectStreams(streams, choice);
    if (selected) {
      await checkHosts(
        [selected.video.url, ...(selected.audio ? [selected.audio.url] : [])],
        trace
      );
      trace?.('plan_ready', {
        protocol: 'tracks',
        extension: selected.extension,
        height: selected.video.height,
      });
      return { kind: 'tracks', ...selected };
    }
    if (!adaptive && !source) {
      if (selectStreams(streams)) throw new SelectionUnavailable();
      throw new Error('The player did not expose a complete downloadable video and audio pair.');
    }
  }
  if (adaptive) {
    const plan = selectAdaptive(adaptive, choice);
    if (!plan) {
      const fallback = selectAdaptive(adaptive);
      trace?.('selection_failed', {
        extension: choice.format,
        height: choice.maxHeight,
        formatCount: adaptive.formats.length,
        videoCount: adaptive.formats.filter(format => format.mimeType?.startsWith('video/')).length,
        audioCount: adaptive.formats.filter(format => format.mimeType?.startsWith('audio/')).length,
        fallbackAvailable: !!fallback,
      });
      if (fallback) throw new SelectionUnavailable();
      throw new Error('The player did not expose a complete downloadable video and audio pair.');
    }
    await checkHosts([adaptive.url], trace);
    trace?.('plan_ready', {
      protocol: 'sabr',
      extension: plan.extension,
      videoFormat: plan.video.itag,
      audioFormat: plan.audio.itag,
      height: plan.video.height,
      duration: adaptive.duration,
    });
    return plan;
  }
  const url = hlsUrl(source);
  if (choice.format === 'webm') throw new SelectionUnavailable();
  if (/\.mp4$/i.test(new URL(url).pathname)) {
    await probeMediaFile(await fetchVideo(url, signal, undefined, {}, trace), signal);
    trace?.('plan_ready', { protocol: 'file', extension: 'mp4' });
    return { kind: 'file', url, extension: 'mp4' };
  }
  const plan = await resolveHls(
    url,
    async selected =>
      new TextDecoder().decode(
        await readHlsResponse(
          await fetchVideo(selected, signal, undefined, {}, trace),
          2 * 1024 * 1024,
          signal
        )
      ),
    choice.maxHeight
  );
  await checkHosts(
    plan.parts.flatMap(part => (part.key ? [part.url, part.key.url] : [part.url])),
    trace
  );
  trace?.('plan_ready', { protocol: 'hls', extension: 'mp4', total: plan.parts.length });
  return plan;
}

export interface Rendition {
  format: 'mp4' | 'webm';
  height: number;
}
export async function inspectVideo(
  context: VideoDownloadContext,
  signal: AbortSignal,
  readManifest = false
): Promise<Rendition[]> {
  if (context.protected || context.kind === 'quiz' || context.kind === 'article') return [];
  const streams = context.streams || [];
  const formats = context.adaptive?.formats || [];
  const candidates = [
    ...streams
      .filter(stream => stream.video)
      .map(stream => ({ mime: stream.mimeType, height: stream.height })),
    ...formats
      .filter(format => format.height)
      .map(format => ({ mime: format.mimeType || '', height: format.height || 0 })),
  ];
  const found: Rendition[] = [];
  for (const candidate of candidates) {
    const format = candidate.mime.startsWith('video/mp4')
      ? 'mp4'
      : candidate.mime.startsWith('video/webm')
        ? 'webm'
        : undefined;
    if (!format || found.some(item => item.format === format && item.height === candidate.height))
      continue;
    const choice: Pick<Preferences, 'format' | 'maxHeight'> = {
      format,
      maxHeight: candidate.height || undefined,
    };
    const direct = selectStreams(streams, choice);
    const adaptive = context.adaptive ? selectAdaptive(context.adaptive, choice) : null;
    if (
      (direct?.video.height === candidate.height && direct.extension === format) ||
      (adaptive?.video.height === candidate.height && adaptive.extension === format)
    )
      found.push({ format, height: candidate.height });
  }
  if (found.length || streams.length || context.adaptive)
    return found.sort((a, b) => b.height - a.height);
  const source = context.sources[0];
  if (!source) return [];
  if (/\.mp4$/i.test(new URL(source).pathname)) return [{ format: 'mp4', height: 0 }];
  if (!readManifest) return [];
  const response = await fetchVideo(source, signal);
  const playlist = parseHls(
    new TextDecoder().decode(await readHlsResponse(response, 2 * 1024 * 1024, signal)),
    source
  );
  return playlist.kind === 'master'
    ? [
        ...new Set(
          playlist.variants.filter(item => !item.externalAudio).map(item => item.height || 0)
        ),
      ]
        .sort((a, b) => b - a)
        .map(height => ({ format: 'mp4', height }))
    : [{ format: 'mp4', height: 0 }];
}

export async function saveDownload(
  context: VideoDownloadContext,
  plan: DownloadPlan | null,
  transcript: string,
  directory: FileSystemDirectoryHandle,
  preferences: Preferences,
  signal: AbortSignal,
  progress: (completed: number, total: number, bytes: number) => void,
  notice: (value: string) => void,
  trace?: Trace
): Promise<void> {
  await assertEntitlement();
  signal.throwIfAborted();
  if (!preferences.video && !preferences.transcript) throw new Error('Choose video or transcript.');
  if (preferences.video && (!plan || context.protected))
    throw new Error('No supported video is ready.');
  if (preferences.transcript && !transcript.trim()) throw new Error('No transcript is ready.');
  const folder = directory;
  const base = `${safeVideoName(context.title)}-${crypto.randomUUID().slice(0, 8)}`;
  if (preferences.transcript) {
    const file = await folder.getFileHandle(`${base}.md`, { create: true });
    const writer = await file.createWritable();
    try {
      await writer.write(
        `# ${context.title.replace(/[\r\n]+/g, ' ')}\n\nSource: ${context.url}\n\n${transcript}\n`
      );
      signal.throwIfAborted();
      await writer.close();
      trace?.('file_saved', { format: 'transcript', extension: 'md' });
    } catch (error) {
      await writer.abort().catch(() => undefined);
      await folder.removeEntry(`${base}.md`).catch(() => undefined);
      throw error;
    }
  }
  if (preferences.video && plan) {
    const filename = `${base}.${plan.kind === 'tracks' || plan.kind === 'adaptive' ? plan.extension : 'mp4'}`;
    let writer: FileSystemWritableFileStream | undefined;
    try {
      writer = await (await folder.getFileHandle(filename, { create: true })).createWritable();
      if (plan.kind === 'file') {
        await writeMediaFile(
          await fetchVideo(plan.url, signal, undefined, {}, trace),
          bytes => writer!.write(bytes as BufferSource),
          signal,
          bytes => progress(0, 0, bytes)
        );
      } else if (plan.kind === 'adaptive') {
        await saveAdaptive(
          plan,
          (url, options) => fetchVideo(url, signal, options.headers, options, trace),
          writer,
          signal,
          progress,
          notice
        );
      } else if (plan.kind === 'tracks') {
        await saveTracks(
          plan,
          (url, headers) => fetchVideo(url, signal, headers, {}, trace),
          writer,
          signal,
          progress,
          notice
        );
      } else {
        await saveMp4(
          write =>
            writeHls(
              plan,
              (part, token) =>
                fetchVideo(
                  part.url,
                  token,
                  part.range
                    ? {
                        Range: `bytes=${part.range.start}-${part.range.start + part.range.length - 1}`,
                      }
                    : undefined,
                  {},
                  trace
                ),
              (key, token) => fetchVideo(key, token, undefined, {}, trace),
              write,
              signal,
              progress
            ),
          writer,
          signal,
          () => notice('Preparing the MP4 file…')
        );
      }
      signal.throwIfAborted();
      await writer.close();
      trace?.('file_saved', {
        format: 'video',
        extension: plan.kind === 'tracks' || plan.kind === 'adaptive' ? plan.extension : 'mp4',
      });
    } catch (error) {
      await writer?.abort().catch(() => undefined);
      await folder.removeEntry(filename).catch(() => undefined);
      if (preferences.transcript)
        notice(`Transcript saved in ${directory.name}. Video was not completed.`);
      throw error;
    }
  }
  notice(
    `Saved ${preferences.video ? 'video' : ''}${preferences.video && preferences.transcript ? ' and ' : ''}${preferences.transcript ? 'transcript' : ''} in ${directory.name}.`
  );
  await saveDirectory(directory, `location:${completionKey(context.url)}`);
  const key = completionKey(context.url, preferences);
  const sharedKey = completionKey(context.url);
  await navigator.locks.request(`completion-${sharedKey}`, { mode: 'exclusive' }, async () => {
    const stored = await chrome.storage.local.get([key, sharedKey]);
    const previous = stored[key] as { video?: boolean; transcript?: boolean } | undefined;
    const shared = stored[sharedKey] as { video?: boolean; transcript?: boolean } | undefined;
    await chrome.storage.local.set({
      [key]: {
        video: preferences.video || previous?.video === true,
        transcript:
          preferences.transcript || previous?.transcript === true || shared?.transcript === true,
      },
      ...(key !== sharedKey
        ? {
            [sharedKey]: {
              video: shared?.video === true,
              transcript: preferences.transcript || shared?.transcript === true,
            },
          }
        : {}),
    });
  });
}
