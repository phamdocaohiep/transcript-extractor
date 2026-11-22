import type { FormatStream } from 'googlevideo/shared-types';
import type { AdaptiveInfo, RequestState } from './playback-session';
import type { Preferences } from './download-types';

export interface StreamInfo {
  url: string;
  mimeType: string;
  video: boolean;
  audio: boolean;
  height: number;
  bitrate: number;
  size?: number;
}

interface Format extends Partial<FormatStream> {
  itag?: number;
  url?: string;
  signatureCipher?: string;
  cipher?: string;
  mimeType?: string;
  height?: number;
  bitrate?: number;
  audioQuality?: string;
  audioSampleRate?: string;
  contentLength?: string;
  drmFamilies?: unknown[];
}
interface ResponseInfo {
  videoDetails?: {
    videoId?: string;
    title?: string;
    isLiveContent?: boolean;
    lengthSeconds?: string;
  };
  playerConfig?: {
    mediaCommonConfig?: { mediaUstreamerRequestConfig?: { videoPlaybackUstreamerConfig?: string } };
  };
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: {
    formats?: Format[];
    adaptiveFormats?: Format[];
    licenseInfos?: unknown[];
    serverAbrStreamingUrl?: string;
  };
}

/** Serialized by Chrome into the page's MAIN world. Keep all runtime helpers inside. */
export function readStreams(): {
  url: string;
  title: string;
  streams: StreamInfo[];
  unavailable?: string;
  adaptive?: AdaptiveInfo;
  diagnostics?: string;
} {
  const current = new URL(location.href);
  const id = current.searchParams.get('v') || current.pathname.match(/^\/shorts\/([^/]+)/)?.[1];
  const empty = { url: current.href, title: document.title, streams: [] as StreamInfo[] };
  if (!/(^|\.)youtube\.com$/.test(current.hostname) || !id) return empty;
  const player = document.getElementById('movie_player') as HTMLElement & {
    getPlayerResponse?: () => ResponseInfo;
  };
  const initial = (window as Window & { ytInitialPlayerResponse?: ResponseInfo })
    .ytInitialPlayerResponse;
  let response: ResponseInfo | undefined;
  try {
    response = player?.getPlayerResponse?.();
  } catch {
    /* Player is being replaced. */
  }
  if (response?.videoDetails?.videoId !== id) response = initial;
  // A playlist navigation may leave the previous video's response in the document.
  if (response?.videoDetails?.videoId !== id) return empty;
  const title = response.videoDetails?.title || document.title;
  if (response.playabilityStatus?.status && response.playabilityStatus.status !== 'OK')
    return {
      ...empty,
      title,
      unavailable:
        response.playabilityStatus.reason ||
        'This video is not available in the current Chrome session.',
    };
  if (response.videoDetails?.isLiveContent)
    return {
      ...empty,
      title,
      unavailable: 'Live broadcasts are not supported. Open an on-demand video.',
    };
  if (response.streamingData?.licenseInfos?.length)
    return { ...empty, title, unavailable: 'DRM-protected video is not supported.' };

  const parse = (value: string | undefined) => {
    try {
      const url = new URL(value || '');
      if (
        url.protocol !== 'https:' ||
        !url.hostname.endsWith('.googlevideo.com') ||
        url.pathname !== '/videoplayback'
      )
        return null;
      if (url.searchParams.has('sq') || url.searchParams.get('ump') === '1') return null;
      return url;
    } catch {
      return null;
    }
  };
  const observed = performance
    .getEntriesByType('resource')
    .map(entry => parse(entry.name))
    .filter((url): url is URL => !!url);
  const streams: StreamInfo[] = [];
  const formats = [
    ...(response.streamingData?.formats || []),
    ...(response.streamingData?.adaptiveFormats || []),
  ];
  for (const format of formats) {
    if (
      format.drmFamilies?.length ||
      !format.mimeType ||
      !/^(video|audio)\/(mp4|webm)\b/.test(format.mimeType)
    )
      continue;
    const cipher = new URLSearchParams(format.signatureCipher || format.cipher || '');
    const original = parse(format.url || cipher.get('url') || undefined);
    if (!original) continue;
    const match = [...observed].reverse().find(
      url =>
        url.searchParams.get('id') === original.searchParams.get('id') &&
        url.searchParams.get('itag') === String(format.itag) &&
        // Avoid taking a previous video's or another session's CDN request.
        original.searchParams.get('id') !== null
    );
    // Use the URL already transformed by the signed-in player. Never evaluate
    // downloaded player scripts or guess signature / throttling parameters.
    const selected =
      match || (!cipher.has('s') && !original.searchParams.has('n') ? original : null);
    if (!selected) continue;
    const url = new URL(selected.href);
    const signed =
      `${url.searchParams.get('sparams') || ''},${url.searchParams.get('lsparams') || ''}`.split(
        ','
      );
    if (url.searchParams.has('range') && signed.includes('range')) continue;
    url.searchParams.delete('range');
    const video = format.mimeType.startsWith('video/');
    const audio =
      !video ||
      !!format.audioQuality ||
      !!format.audioSampleRate ||
      /mp4a|opus|vorbis/.test(format.mimeType);
    const size = Number(format.contentLength || url.searchParams.get('clen'));
    streams.push({
      url: url.href,
      mimeType: format.mimeType,
      video,
      audio,
      height: format.height || 0,
      bitrate: format.bitrate || 0,
      size: Number.isSafeInteger(size) && size > 0 ? size : undefined,
    });
  }
  const state = (window as Window & { __tePlaybackRequest?: RequestState }).__tePlaybackRequest;
  const session = state?.session;
  const expected =
    response.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig
      ?.videoPlaybackUstreamerConfig;
  const normalize = (value: string) =>
    value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const duration =
    Number(response.videoDetails?.lengthSeconds) ||
    Math.max(0, ...formats.map(format => Number(format.approxDurationMs || 0) / 1000));
  const adaptive: AdaptiveInfo | undefined =
    session?.videoId === id &&
    duration > 0 &&
    formats.some(
      format =>
        format.lastModified && !format.drmFamilies?.length && format.mimeType?.startsWith('video/')
    ) &&
    formats.some(
      format =>
        format.lastModified && !format.drmFamilies?.length && format.mimeType?.startsWith('audio/')
    ) &&
    (!expected || normalize(expected) === normalize(session.config))
      ? {
          ...session,
          duration,
          formats: formats
            .filter(
              format =>
                !format.drmFamilies?.length && format.itag && format.lastModified && format.mimeType
            )
            .map(format => ({
              itag: format.itag!,
              lastModified: format.lastModified,
              mimeType: format.mimeType,
              bitrate: format.bitrate || 0,
              width: format.width,
              height: format.height,
              fps: format.fps,
              quality: format.quality,
              qualityLabel: format.qualityLabel,
              audioQuality: format.audioQuality,
              audioChannels: format.audioChannels,
              approxDurationMs: format.approxDurationMs || String(duration * 1000),
              contentLength: format.contentLength,
              xtags: format.xtags,
              audioTrack: format.audioTrack ? { id: format.audioTrack.id } : undefined,
            })),
        }
      : undefined;
  const diagnostics = `${formats.length} formats; ${streams.length} direct streams; ${response.streamingData?.serverAbrStreamingUrl ? 'SABR available' : 'SABR not advertised'}; observer ${state?.installed ? 'active' : 'not loaded'}; playback session ${adaptive ? 'captured' : 'not captured'}.`;
  return { url: current.href, title, streams, adaptive, diagnostics };
}

/** Prefer AVC/AAC when exposed, without discarding AV1 or Opus playback formats. */
export function selectStreams(
  streams: StreamInfo[],
  choice: Pick<Preferences, 'format' | 'maxHeight'> = {}
) {
  const ranked = [...streams].sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
  for (const family of ['mp4', 'webm']) {
    if (choice.format && family !== choice.format) continue;
    const videos = ranked
      .filter(
        stream =>
          stream.video &&
          stream.mimeType.startsWith(`video/${family}`) &&
          (!choice.maxHeight || !stream.height || stream.height <= choice.maxHeight)
      )
      .sort(
        (a, b) =>
          (choice.maxHeight ? b.height - a.height : 0) ||
          Number(/avc1|avc3/.test(b.mimeType)) - Number(/avc1|avc3/.test(a.mimeType)) ||
          b.height - a.height ||
          b.bitrate - a.bitrate
      );
    for (const video of videos) {
      const audio =
        streams
          .filter(
            stream => !stream.video && stream.audio && stream.mimeType.startsWith(`audio/${family}`)
          )
          .sort((a, b) => b.bitrate - a.bitrate)[0] ||
        (family === 'mp4'
          ? streams
              .filter(
                stream => !stream.video && stream.audio && /audio\/webm.*opus/.test(stream.mimeType)
              )
              .sort((a, b) => b.bitrate - a.bitrate)[0]
          : undefined);
      if (video.audio || audio)
        return {
          video,
          audio: video.audio ? undefined : audio,
          extension: family as 'mp4' | 'webm',
        };
    }
  }
  return null;
}
