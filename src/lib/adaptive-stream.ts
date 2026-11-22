import { SabrStream } from 'googlevideo/sabr-stream';
import { buildSabrFormat, Logger, LogLevel } from 'googlevideo/utils';
import type { SabrFormat } from 'googlevideo/shared-types';
import type { AdaptiveInfo } from './playback-session';
import { selectStreams, type StreamInfo } from './stream-discovery';
import { saveTracks } from './track-file';
import type { Preferences } from './download-types';

export interface AdaptivePlan {
  kind: 'adaptive';
  session: AdaptiveInfo;
  video: SabrFormat;
  audio: SabrFormat;
  extension: 'mp4' | 'webm';
}

export function selectAdaptive(
  session: AdaptiveInfo,
  choice: Pick<Preferences, 'format' | 'maxHeight'> = {}
): AdaptivePlan | null {
  const formats = session.formats
    .map(source => {
      const format = buildSabrFormat(source);
      const mime = format.mimeType || '';
      // Quality labels are optional player metadata, not track-type identifiers.
      return {
        ...format,
        hasVideo: format.hasVideo || mime.startsWith('video/'),
        hasAudio: format.hasAudio || mime.startsWith('audio/') || /mp4a|opus|vorbis/.test(mime),
      };
    })
    .filter(format => !format.hasText && format.hasVideo !== format.hasAudio);
  const candidates: StreamInfo[] = formats.map(format => ({
    url: session.url,
    mimeType: format.mimeType || '',
    video: format.hasVideo,
    audio: format.hasAudio,
    height: format.height || 0,
    bitrate: format.bitrate,
  }));
  const selected = selectStreams(candidates, choice);
  if (!selected?.audio) return null;
  return {
    kind: 'adaptive',
    session,
    video: formats[candidates.indexOf(selected.video)],
    audio: formats[candidates.indexOf(selected.audio)],
    extension: selected.extension,
  };
}

/** Download SABR with the page's existing session; never mint or export credentials. */
export async function saveAdaptive(
  plan: AdaptivePlan,
  fetchPart: (url: string, options: RequestInit) => Promise<Response>,
  destination: FileSystemWritableFileStream,
  signal: AbortSignal,
  progress: (completed: number, total: number, bytes: number) => void,
  notice: (value: string) => void
) {
  Logger.getInstance().setLogLevels(LogLevel.NONE);
  let fetchFailure: unknown;
  const stream = new SabrStream({
    videoId: plan.session.videoId,
    serverAbrStreamingUrl: plan.session.url,
    videoPlaybackUstreamerConfig: plan.session.config,
    clientInfo: plan.session.clientInfo,
    poToken: plan.session.token,
    formats: [plan.video, plan.audio],
    fetchFunction: async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        url.protocol !== 'https:' ||
        !url.hostname.endsWith('.googlevideo.com') ||
        url.pathname !== '/videoplayback'
      )
        throw new Error('The playback server returned an unsupported destination.');
      try {
        signal.throwIfAborted();
        const response = await fetchPart(url.href, options || {});
        if (!response.ok) throw new Error(`Video server returned HTTP ${response.status}.`);
        return response;
      } catch (error) {
        fetchFailure = error;
        throw error;
      }
    },
  });
  let failed = false;
  stream.on('error', () => {
    failed = true;
  });
  const cancel = () => {
    void stream.abort().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const result = stream.start({
      videoFormat: plan.video.itag,
      audioFormat: plan.audio.itag,
      isPostLiveDvr: false,
      maxRetries: 2,
      stallDetectionMs: 15_000,
    });
    await saveTracks(
      {
        kind: 'tracks',
        extension: plan.extension,
        video: {
          url: plan.session.url,
          mimeType: plan.video.mimeType || '',
          video: true,
          audio: false,
          height: plan.video.height || 0,
          bitrate: plan.video.bitrate,
        },
        audio: {
          url: plan.session.url,
          mimeType: plan.audio.mimeType || '',
          video: false,
          audio: true,
          height: 0,
          bitrate: plan.audio.bitrate,
        },
      },
      async () => {
        throw new Error('A direct file request is not used for this playback stream.');
      },
      destination,
      signal,
      progress,
      notice,
      { video: result.videoStream, audio: result.audioStream, duration: plan.session.duration }
    );
    signal.throwIfAborted();
    if (failed || stream.isErrored)
      throw new Error(
        'The Chrome playback session expired or the streaming request was interrupted.'
      );
  } catch (error) {
    signal.throwIfAborted();
    if (fetchFailure) throw fetchFailure;
    if (failed)
      throw new Error(
        'The Chrome playback session expired or the streaming request was interrupted.'
      );
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    await stream.abort().catch(() => undefined);
  }
}
