import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolvePlayback } from './playback';
import type { VideoDownloadContext } from './hls-discovery';
const url = 'https://www.udemy.com/course/test/learn/lecture/1';
const signal = () => new AbortController().signal;
const context: VideoDownloadContext = {
  url,
  title: 'Video',
  sources: [],
  protected: false,
  hasPlayer: true,
  loading: false,
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it('reloads and primes a lazy player automatically when no stream appears', async () => {
  let reloaded = false;
  const prime = vi.fn(async () => undefined);
  const reload = vi.fn(async () => {
    reloaded = true;
  });
  const read = vi.fn(async () => ({
    ...context,
    sources: reloaded ? ['https://cdn.test/video.m3u8'] : [],
  }));
  const pending = resolvePlayback(url, read, prime, reload, signal(), vi.fn());
  await vi.runAllTimersAsync();
  expect((await pending).sources).toHaveLength(1);
  expect(reload).toHaveBeenCalledOnce();
  expect(prime).toHaveBeenCalled();
});
it('identifies a settled text page without treating it as a broken player', async () => {
  const reload = vi.fn();
  const pending = resolvePlayback(
    url,
    async () => ({ ...context, hasPlayer: false, kind: 'article' as const }),
    vi.fn(),
    reload,
    signal(),
    vi.fn()
  );
  await vi.runAllTimersAsync();
  expect((await pending).hasPlayer).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});
it('reports a player with no supported stream after a bounded reload retry', async () => {
  const reload = vi.fn(async () => undefined);
  const pending = expect(
    resolvePlayback(
      url,
      async () => context,
      vi.fn(async () => undefined),
      reload,
      signal(),
      vi.fn()
    )
  ).rejects.toThrow('no supported HLS or MP4');
  await vi.runAllTimersAsync();
  await pending;
  expect(reload).toHaveBeenCalledOnce();
});
it('stops recovery when the download is cancelled', async () => {
  const abort = new AbortController();
  const pending = expect(
    resolvePlayback(url, async () => context, vi.fn(), vi.fn(), abort.signal, vi.fn())
  ).rejects.toThrow();
  abort.abort();
  await vi.runAllTimersAsync();
  await pending;
});
it('waits for delayed hydration rather than skipping a video with no element yet', async () => {
  let polls = 0;
  const reload = vi.fn();
  const pending = resolvePlayback(
    url,
    async () => ({
      ...context,
      kind: 'video',
      hasPlayer: ++polls >= 8,
      sources: polls >= 8 ? ['https://cdn.test/video.m3u8'] : [],
    }),
    vi.fn(async () => undefined),
    reload,
    signal(),
    vi.fn()
  );
  await vi.runAllTimersAsync();
  expect((await pending).sources).toHaveLength(1);
  expect(reload).not.toHaveBeenCalled();
});
it('retries a missing video element after reload instead of persisting a skipped video', async () => {
  let reloaded = false;
  const reload = vi.fn(async () => {
    reloaded = true;
  });
  const pending = resolvePlayback(
    url,
    async () => ({
      ...context,
      kind: 'video',
      hasPlayer: reloaded,
      sources: reloaded ? ['https://cdn.test/video.m3u8'] : [],
    }),
    vi.fn(async () => undefined),
    reload,
    signal(),
    vi.fn()
  );
  await vi.runAllTimersAsync();
  expect((await pending).hasPlayer).toBe(true);
  expect(reload).toHaveBeenCalledOnce();
});

it('primes YouTube before giving up when its transformed requests have not appeared yet', async () => {
  let playing = false;
  const prime = vi.fn(async () => {
    playing = true;
  });
  const pending = resolvePlayback(
    'https://www.youtube.com/watch?v=example',
    async () => ({
      ...context,
      url: 'https://www.youtube.com/watch?v=example',
      streams: playing
        ? [
            {
              url: 'https://r1.googlevideo.com/videoplayback?id=test',
              mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
              video: true,
              audio: true,
              height: 720,
              bitrate: 1000,
            },
          ]
        : [],
    }),
    prime,
    vi.fn(),
    signal(),
    vi.fn()
  );
  await vi.runAllTimersAsync();
  expect((await pending).streams).toHaveLength(1);
  expect(prime).toHaveBeenCalledOnce();
});
