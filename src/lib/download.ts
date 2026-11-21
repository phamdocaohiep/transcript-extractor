import { hlsUrl, readHlsResponse, resolveHls, safeVideoName, writeHls, type HlsPlan } from './hls';
import { probeMediaFile, writeMediaFile } from './media-file';
import { saveMp4 } from './mp4';
import { selectStreams, type StreamInfo } from './stream-discovery';
import { saveTracks, type TrackPlan } from './track-file';
import type { VideoDownloadContext } from './hls-discovery';
import type { Preferences } from './download-types';
import { groupKey } from './identity';
import { assertEntitlement } from './subscription';
import { lectureId } from './collection';

export const completionKey = (url: string) => `download_completed:${lectureId(url, '')}`;

export class HostAccessNeeded extends Error {
  constructor(public origins: string[]) {
    super('Allow access to the video host, then retry.');
  }
}

export type DownloadPlan = HlsPlan | { kind: 'file'; url: string; extension: 'mp4' } | TrackPlan;
export async function checkHosts(urls: string[]) {
  const origins = [...new Set(urls.map(url => `${new URL(hlsUrl(url)).origin}/*`))];
  const missing: string[] = [];
  for (const origin of origins) {
    if (!(await chrome.permissions.contains({ origins: [origin] }))) missing.push(origin);
  }
  if (missing.length) throw new HostAccessNeeded(missing);
}
export async function fetchVideo(url: string, signal: AbortSignal, headers?: HeadersInit) {
  await checkHosts([url]);
  // Signed URLs are used as supplied. Never synthesize auth headers or follow
  // redirects to an unapproved host.
  return fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
    headers,
    credentials: 'include',
    redirect: 'error',
  });
}

export async function prepareVideo(
  source: string,
  signal: AbortSignal,
  streams?: StreamInfo[]
): Promise<DownloadPlan> {
  signal.throwIfAborted();
  if (streams?.length) {
    const selected = selectStreams(streams);
    if (selected) {
      await checkHosts([selected.video.url, ...(selected.audio ? [selected.audio.url] : [])]);
      return { kind: 'tracks', ...selected };
    }
  }
  const url = hlsUrl(source);
  if (/\.mp4$/i.test(new URL(url).pathname)) {
    await probeMediaFile(await fetchVideo(url, signal), signal);
    return { kind: 'file', url, extension: 'mp4' };
  }
  const plan = await resolveHls(url, async selected =>
    new TextDecoder().decode(
      await readHlsResponse(await fetchVideo(selected, signal), 2 * 1024 * 1024, signal)
    )
  );
  await checkHosts(plan.parts.flatMap(part => (part.key ? [part.url, part.key.url] : [part.url])));
  return plan;
}

export async function saveDownload(
  context: VideoDownloadContext,
  plan: DownloadPlan | null,
  transcript: string,
  directory: FileSystemDirectoryHandle,
  preferences: Preferences,
  signal: AbortSignal,
  progress: (completed: number, total: number, bytes: number) => void,
  notice: (value: string) => void
): Promise<void> {
  await assertEntitlement();
  signal.throwIfAborted();
  if (!preferences.video && !preferences.transcript) throw new Error('Choose video or transcript.');
  if (preferences.video && (!plan || context.protected))
    throw new Error('No supported video is ready.');
  if (preferences.transcript && !transcript.trim()) throw new Error('No transcript is ready.');
  const url = new URL(groupKey(context.url));
  const identifier =
    url.searchParams.get('list') ||
    url.searchParams.get('v') ||
    url.pathname.split('/').filter(Boolean).at(-1) ||
    'collection';
  const name = safeVideoName(`${url.hostname}_${identifier}`);
  const folder = await directory.getDirectoryHandle(name, { create: true });
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
    } catch (error) {
      await writer.abort().catch(() => undefined);
      await folder.removeEntry(`${base}.md`).catch(() => undefined);
      throw error;
    }
  }
  if (preferences.video && plan) {
    const filename = `${base}.${plan.kind === 'tracks' ? plan.extension : 'mp4'}`;
    let writer: FileSystemWritableFileStream | undefined;
    try {
      writer = await (await folder.getFileHandle(filename, { create: true })).createWritable();
      if (plan.kind === 'file') {
        await writeMediaFile(
          await fetchVideo(plan.url, signal),
          bytes => writer!.write(bytes as BufferSource),
          signal,
          bytes => progress(0, 0, bytes)
        );
      } else if (plan.kind === 'tracks') {
        await saveTracks(
          plan,
          (url, headers) => fetchVideo(url, signal, headers),
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
                    : undefined
                ),
              (key, token) => fetchVideo(key, token),
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
    } catch (error) {
      await writer?.abort().catch(() => undefined);
      await folder.removeEntry(filename).catch(() => undefined);
      if (preferences.transcript)
        notice(`Transcript saved in ${directory.name}/${name}. Video was not completed.`);
      throw error;
    }
  }
  notice(
    `Saved ${preferences.video ? 'video' : ''}${preferences.video && preferences.transcript ? ' and ' : ''}${preferences.transcript ? 'transcript' : ''} in ${directory.name}/${name}.`
  );
  const key = completionKey(context.url);
  const previous = (await chrome.storage.local.get(key))[key] as
    | { video?: boolean; transcript?: boolean }
    | undefined;
  await chrome.storage.local.set({
    [key]: {
      video: preferences.video || previous?.video === true,
      transcript: preferences.transcript || previous?.transcript === true,
    },
  });
}
