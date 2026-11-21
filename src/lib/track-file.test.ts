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
