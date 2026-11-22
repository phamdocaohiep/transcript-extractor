import { expect, it } from 'vitest';
import { selectStreams, type StreamInfo } from './stream-discovery';
import { selectAdaptive } from './adaptive-stream';
import { resolveHls } from './hls';
import { inspectVideo } from './download';
import type { AdaptiveInfo } from './playback-session';

const streams: StreamInfo[] = [
  {
    url: 'https://cdn.test/720',
    mimeType: 'video/mp4; codecs="avc1"',
    video: true,
    audio: false,
    height: 720,
    bitrate: 2000,
  },
  {
    url: 'https://cdn.test/1080',
    mimeType: 'video/mp4; codecs="av01"',
    video: true,
    audio: false,
    height: 1080,
    bitrate: 3000,
  },
  {
    url: 'https://cdn.test/2160',
    mimeType: 'video/webm; codecs="vp9"',
    video: true,
    audio: false,
    height: 2160,
    bitrate: 5000,
  },
  {
    url: 'https://cdn.test/a',
    mimeType: 'audio/mp4; codecs="mp4a.40.2"',
    video: false,
    audio: true,
    height: 0,
    bitrate: 128,
  },
  {
    url: 'https://cdn.test/b',
    mimeType: 'audio/webm; codecs="opus"',
    video: false,
    audio: true,
    height: 0,
    bitrate: 160,
  },
];
it('applies the selected container and resolution while keeping compatible audio', () => {
  expect(selectStreams(streams)?.video.height).toBe(720);
  expect(selectStreams(streams, { format: 'mp4', maxHeight: 1080 })?.video.height).toBe(1080);
  const webm = selectStreams(streams, { format: 'webm', maxHeight: 2160 });
  expect(webm?.video.height).toBe(2160);
  expect(webm?.audio?.mimeType).toContain('opus');
  expect(selectStreams(streams, { format: 'webm', maxHeight: 1080 })).toBeNull();
});
it('does not advertise a higher resolution when only the lower progressive stream has audio', async () => {
  const available = await inspectVideo(
    {
      url: 'https://www.youtube.com/watch?v=example',
      title: 'Example',
      sources: [],
      protected: false,
      streams: [{ ...streams[0], audio: true }, streams[1]],
    },
    new AbortController().signal
  );
  expect(available).toEqual([{ format: 'mp4', height: 720 }]);
});
it('uses the same selected resolution for SABR instead of always choosing its default format', () => {
  const session = {
    videoId: 'example',
    url: 'https://r1.googlevideo.com/videoplayback',
    config: '',
    clientInfo: {},
    duration: 30,
    formats: streams.map((stream, index) => ({
      itag: index + 1,
      mimeType: stream.mimeType,
      height: stream.height,
      bitrate: stream.bitrate,
      qualityLabel: stream.video ? `${stream.height}p` : undefined,
      audioQuality: stream.audio ? 'AUDIO_QUALITY_MEDIUM' : undefined,
      width: stream.height ? 1920 : undefined,
      audioSampleRate: stream.audio ? '48000' : undefined,
      audioChannels: stream.audio ? 2 : undefined,
    })),
  } as AdaptiveInfo;
  const selected = selectAdaptive(session, { format: 'webm', maxHeight: 2160 });
  expect(selected?.extension).toBe('webm');
  expect(selected?.video.height).toBe(2160);
});
it('selects a lower HLS rendition and fails clearly if no rendition meets the selected limit', async () => {
  const read = async (url: string) =>
    url.endsWith('master.m3u8')
      ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000,RESOLUTION=1920x1080\n1080.m3u8'
      : '#EXTM3U\n#EXTINF:3,\npart.ts\n#EXT-X-ENDLIST';
  expect((await resolveHls('https://cdn.test/master.m3u8', read, 720)).playlistUrl).toBe(
    'https://cdn.test/720.m3u8'
  );
  await expect(resolveHls('https://cdn.test/master.m3u8', read, 360)).rejects.toThrow(
    'selected resolution'
  );
});
