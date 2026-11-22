import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolvePlayback } from './playback';
import type { VideoDownloadContext } from './hls-discovery';
const url = 'https://www.udemy.com/course/test/learn/lecture/1';
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
it('does not reload by default when the player has no downloadable stream', async () => {
  const reload = vi.fn();
  const pending = expect(
    resolvePlayback(url, async () => context, reload, new AbortController().signal, vi.fn())
  ).rejects.toThrow('Play the video manually');
  await vi.runAllTimersAsync();
  await pending;
  expect(reload).not.toHaveBeenCalled();
});
it('reloads once only when explicitly enabled and reuses the newly exposed stream', async () => {
  let reloaded = false;
  const reload = vi.fn(async () => {
    reloaded = true;
  });
  const pending = resolvePlayback(
    url,
    async () => ({ ...context, sources: reloaded ? ['https://cdn.test/video.m3u8'] : [] }),
    reload,
    new AbortController().signal,
    vi.fn(),
    true
  );
  await vi.runAllTimersAsync();
  expect((await pending).sources).toHaveLength(1);
  expect(reload).toHaveBeenCalledOnce();
});
it('identifies a text page without reloading', async () => {
  const reload = vi.fn();
  const result = await resolvePlayback(
    url,
    async () => ({ ...context, hasPlayer: false, kind: 'article' }),
    reload,
    new AbortController().signal,
    vi.fn()
  );
  expect(result.hasPlayer).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});
it('stops observing when cancelled', async () => {
  const abort = new AbortController();
  const reload = vi.fn();
  const pending = expect(
    resolvePlayback(url, async () => context, reload, abort.signal, vi.fn(), true)
  ).rejects.toThrow();
  abort.abort();
  await vi.runAllTimersAsync();
  await pending;
  expect(reload).not.toHaveBeenCalled();
});
it('waits for delayed hydration without starting playback or reloading', async () => {
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
    reload,
    new AbortController().signal,
    vi.fn()
  );
  await vi.runAllTimersAsync();
  expect((await pending).sources).toHaveLength(1);
  expect(reload).not.toHaveBeenCalled();
});
it('reports missing YouTube streams with manual playback guidance instead of starting the player', async () => {
  const address = 'https://www.youtube.com/watch?v=example';
  const reload = vi.fn();
  const pending = expect(
    resolvePlayback(
      address,
      async () => ({ ...context, url: address, streams: [] }),
      reload,
      new AbortController().signal,
      vi.fn()
    )
  ).rejects.toThrow('Play the video manually');
  await vi.runAllTimersAsync();
  await pending;
  expect(reload).not.toHaveBeenCalled();
});
it('bounds an opted-in reload retry when the stream remains unavailable', async () => {
  const reload = vi.fn();
  const pending = expect(
    resolvePlayback(url, async () => context, reload, new AbortController().signal, vi.fn(), true)
  ).rejects.toThrow('no supported HLS or MP4');
  await vi.runAllTimersAsync();
  await pending;
  expect(reload).toHaveBeenCalledOnce();
});
