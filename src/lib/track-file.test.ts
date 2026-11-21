import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BlobSource, Input, MP4, EncodedPacketSink } from 'mediabunny';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { saveTracks, type TrackPlan } from './track-file';
const picture = new Uint8Array(
  readFileSync(new URL('./__fixtures__/media/picture.mp4', import.meta.url))
);
const sound = new Uint8Array(
  readFileSync(new URL('./__fixtures__/media/sound.m4a', import.meta.url))
);
const plan: TrackPlan = {
  kind: 'tracks',
  extension: 'mp4',
  video: {
    url: 'https://r1.googlevideo.com/videoplayback?id=picture',
    mimeType: 'video/mp4',
    video: true,
    audio: false,
    height: 72,
    bitrate: 10000,
    size: picture.length,
  },
  audio: {
    url: 'https://r1.googlevideo.com/videoplayback?id=sound',
    mimeType: 'audio/mp4',
    video: false,
    audio: true,
    height: 0,
    bitrate: 48000,
    size: sound.length,
  },
};
let files: Map<string, Uint8Array>;
let output: Uint8Array;
let destination: FileSystemWritableFileStream;
beforeEach(() => {
  files = new Map();
  output = new Uint8Array();
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getFileHandle: async (name: string) => ({
          createWritable: async () => {
            files.set(name, new Uint8Array());
            return {
              write: async (data: Uint8Array) => {
                const before = files.get(name)!;
                const combined = new Uint8Array(before.length + data.length);
                combined.set(before);
                combined.set(data, before.length);
                files.set(name, combined);
              },
              close: async () => undefined,
              abort: async () => undefined,
            };
          },
          getFile: async () => new File([files.get(name)! as BlobPart], name),
        }),
        removeEntry: async (name: string) => {
          files.delete(name);
        },
      }),
    },
  });
  destination = {
    write: async (chunk: { position: number; data: Uint8Array }) => {
      const next = new Uint8Array(Math.max(output.length, chunk.position + chunk.data.length));
      next.set(output);
      next.set(chunk.data, chunk.position);
      output = next;
    },
  } as unknown as FileSystemWritableFileStream;
});
afterEach(() => vi.unstubAllGlobals());
const fetchPart = async (url: string, headers: HeadersInit) => {
  const file = new URL(url).searchParams.get('id') === 'sound' ? sound : picture;
  const range = new Headers(headers).get('Range')!.match(/bytes=(\d+)-(\d+)/)!;
  const start = Number(range[1]),
    end = Math.min(Number(range[2]), file.length - 1);
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}` },
  });
};
it('combines complete independent video/audio files into a seekable MP4 with both tracks', async () => {
  await saveTracks(plan, fetchPart, destination, new AbortController().signal, vi.fn(), vi.fn());
  expect(files.size).toBe(0);
  const input = new Input({
    source: new BlobSource(new File([output as BlobPart], 'result.mp4')),
    formats: [MP4],
  });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    expect(await video?.getCodec()).toBe('avc');
    expect(await audio?.getCodec()).toBe('aac');
    expect(await input.computeDuration()).toBeGreaterThanOrEqual(1);
    let count = 0;
    for await (const packet of new EncodedPacketSink(video!).packets()) count++;
    expect(count).toBe(10);
  } finally {
    input.dispose();
  }
  // Independent decoder proof where the development tool is installed. The
  // extension itself only uses its bundled JavaScript and browser storage.
  if (spawnSync('ffmpeg', ['-version']).status === 0) {
    const folder = mkdtempSync(join(tmpdir(), 'remux-proof-'));
    try {
      const path = join(folder, 'result.mp4');
      writeFileSync(path, output);
      const result = spawnSync(
        'ffmpeg',
        ['-v', 'error', '-i', path, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'],
        { encoding: 'utf8' }
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});
it('rejects a missing audio track and cleans temporary files', async () => {
  await expect(
    saveTracks(
      { ...plan, audio: undefined },
      fetchPart,
      destination,
      new AbortController().signal,
      vi.fn(),
      vi.fn()
    )
  ).rejects.toThrow('Both video and audio');
  expect(files.size).toBe(0);
});
it('cleans staged files when the second transfer fails', async () => {
  await expect(
    saveTracks(
      plan,
      async (url, headers) =>
        new URL(url).searchParams.get('id') === 'sound'
          ? new Response(null, { status: 403 })
          : fetchPart(url, headers),
      destination,
      new AbortController().signal,
      vi.fn(),
      vi.fn()
    )
  ).rejects.toThrow('HTTP 403');
  expect(files.size).toBe(0);
});

it('preserves VP9 picture and Opus audio in a WebM file', async () => {
  const videoBytes = new Uint8Array(
    readFileSync(new URL('./__fixtures__/media/picture.webm', import.meta.url))
  );
  const audioBytes = new Uint8Array(
    readFileSync(new URL('./__fixtures__/media/sound.webm', import.meta.url))
  );
  const { WEBM } = await import('mediabunny');
  const selected: TrackPlan = {
    ...plan,
    extension: 'webm',
    video: { ...plan.video, mimeType: 'video/webm', size: videoBytes.length },
    audio: { ...plan.audio!, mimeType: 'audio/webm', size: audioBytes.length },
  };
  await saveTracks(
    selected,
    async (url, headers) => {
      const file = new URL(url).searchParams.get('id') === 'sound' ? audioBytes : videoBytes;
      const range = new Headers(headers).get('Range')!.match(/bytes=(\d+)-(\d+)/)!;
      const start = Number(range[1]),
        end = Math.min(Number(range[2]), file.length - 1);
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}` },
      });
    },
    destination,
    new AbortController().signal,
    vi.fn(),
    vi.fn()
  );
  const input = new Input({
    source: new BlobSource(new File([output as BlobPart], 'result.webm')),
    formats: [WEBM],
  });
  try {
    expect(await (await input.getPrimaryVideoTrack())?.getCodec()).toBe('vp9');
    expect(await (await input.getPrimaryAudioTrack())?.getCodec()).toBe('opus');
    expect(await input.computeDuration()).toBeGreaterThanOrEqual(1);
  } finally {
    input.dispose();
  }
  expect(files.size).toBe(0);
});

it('can combine an MP4 picture track with a WebM Opus audio track', async () => {
  const audioBytes = new Uint8Array(
    readFileSync(new URL('./__fixtures__/media/sound.webm', import.meta.url))
  );
  await saveTracks(
    {
      ...plan,
      audio: { ...plan.audio!, mimeType: 'audio/webm; codecs="opus"', size: audioBytes.length },
    },
    async (url, headers) => {
      if (new URL(url).searchParams.get('id') !== 'sound') return fetchPart(url, headers);
      return new Response(audioBytes, {
        status: 206,
        headers: { 'Content-Range': `bytes 0-${audioBytes.length - 1}/${audioBytes.length}` },
      });
    },
    destination,
    new AbortController().signal,
    vi.fn(),
    vi.fn()
  );
  const input = new Input({
    source: new BlobSource(new File([output as BlobPart], 'result.mp4')),
    formats: [MP4],
  });
  try {
    expect(await (await input.getPrimaryVideoTrack())?.getCodec()).toBe('avc');
    expect(await (await input.getPrimaryAudioTrack())?.getCodec()).toBe('opus');
    expect(await input.computeDuration()).toBeGreaterThanOrEqual(1);
  } finally {
    input.dispose();
  }
});

it('consumes independent streaming tracks concurrently and validates the full duration', async () => {
  const source = (bytes: Uint8Array) =>
    new ReadableStream<ArrayBufferView>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  await saveTracks(plan, vi.fn(), destination, new AbortController().signal, vi.fn(), vi.fn(), {
    video: source(picture),
    audio: source(sound),
    duration: 1,
  });
  const input = new Input({
    source: new BlobSource(new File([output as BlobPart], 'result.mp4')),
    formats: [MP4],
  });
  try {
    expect(await input.getPrimaryVideoTrack()).not.toBeNull();
    expect(await input.getPrimaryAudioTrack()).not.toBeNull();
    expect(await input.computeDuration()).toBeGreaterThanOrEqual(1);
  } finally {
    input.dispose();
  }
  expect(files.size).toBe(0);
});

it('rejects a streaming response that finishes before the advertised duration', async () => {
  const source = (bytes: Uint8Array) =>
    new ReadableStream<ArrayBufferView>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  await expect(
    saveTracks(plan, vi.fn(), destination, new AbortController().signal, vi.fn(), vi.fn(), {
      video: source(picture),
      audio: source(sound),
      duration: 60,
    })
  ).rejects.toThrow('before the full video');
  expect(files.size).toBe(0);
});

it('downloads an actual UMP-encoded SABR response and combines both media tracks', async () => {
  const { saveAdaptive, selectAdaptive } = await import('./adaptive-stream');
  const { CompositeBuffer, UmpWriter } = await import('googlevideo/ump');
  const { UMPPartId, FormatInitializationMetadata, MediaHeader, VideoPlaybackAbrRequest } =
    await import('googlevideo/protos');
  const buffer = new CompositeBuffer();
  const writer = new UmpWriter(buffer);
  for (const [headerId, itag, data, mimeType] of [
    [1, 137, picture, 'video/mp4'],
    [2, 140, sound, 'audio/mp4'],
  ] as const) {
    const formatId = { itag, lastModified: '1', xtags: '' };
    writer.write(
      UMPPartId.FORMAT_INITIALIZATION_METADATA,
      FormatInitializationMetadata.encode({
        videoId: 'example',
        formatId,
        mimeType,
        endSegmentNum: '1',
        endTimeTicks: '1000',
        endTimeTimescale: '1000',
      }).finish()
    );
    writer.write(
      UMPPartId.MEDIA_HEADER,
      MediaHeader.encode({
        headerId,
        videoId: 'example',
        itag,
        formatId,
        segmentNum: 1,
        isInitializationSegment: false,
        startMs: '0',
        durationMs: '1000',
        segmentLengthBytes: String(data.length),
        segmentByteRangeStart: '0',
        timeRange: { startTicks: '0', durationTicks: '1000', timescale: 1000 },
      }).finish()
    );
    writer.write(UMPPartId.MEDIA, new Uint8Array([headerId, ...data]));
    writer.write(UMPPartId.MEDIA_END, new Uint8Array([headerId]));
  }
  const response = new Uint8Array(buffer.getLength());
  let position = 0;
  for (const chunk of buffer.chunks) {
    response.set(chunk, position);
    position += chunk.length;
  }
  const selected = selectAdaptive({
    videoId: 'example',
    url: 'https://r1.googlevideo.com/videoplayback?ump=1',
    config: 'AQI=',
    token: 'AwQ=',
    duration: 1,
    clientInfo: { clientName: 1, clientVersion: 'fixture' },
    formats: [
      {
        itag: 137,
        lastModified: '1',
        bitrate: 1000,
        mimeType: 'video/mp4; codecs="avc1.640028"',
        qualityLabel: '720p',
        height: 720,
        approxDurationMs: '1000',
      },
      {
        itag: 140,
        lastModified: '1',
        bitrate: 128,
        mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        audioQuality: 'AUDIO_QUALITY_MEDIUM',
        approxDurationMs: '1000',
      },
    ],
  })!;
  expect(selected).not.toBeNull();
  const request = vi.fn(async (_url: string, options: RequestInit) => {
    const decoded = VideoPlaybackAbrRequest.decode(options.body as Uint8Array);
    expect(decoded.streamerContext?.poToken).toEqual(new Uint8Array([3, 4]));
    expect(decoded.selectedVideoFormatIds[0].itag).toBe(137);
    expect(decoded.selectedAudioFormatIds[0].itag).toBe(140);
    return new Response(response, { headers: { 'Content-Type': 'application/vnd.yt-ump' } });
  });
  await saveAdaptive(
    selected,
    request,
    destination,
    new AbortController().signal,
    vi.fn(),
    vi.fn()
  );
  expect(request).toHaveBeenCalledOnce();
  const input = new Input({
    source: new BlobSource(new File([output as BlobPart], 'result.mp4')),
    formats: [MP4],
  });
  try {
    expect(await (await input.getPrimaryVideoTrack())?.getCodec()).toBe('avc');
    expect(await (await input.getPrimaryAudioTrack())?.getCodec()).toBe('aac');
    expect(await input.computeDuration()).toBeGreaterThanOrEqual(1);
  } finally {
    input.dispose();
  }
  expect(files.size).toBe(0);
});
