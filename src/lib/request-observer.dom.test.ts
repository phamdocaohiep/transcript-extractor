// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.youtube.com/watch?v=example" }
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { VideoPlaybackAbrRequest } from 'googlevideo/protos';
import { installObserver } from './request-observer';
import type { RequestState } from './playback-session';
let cleanup: () => void;
const state = () => (window as Window & { __tePlaybackRequest?: RequestState }).__tePlaybackRequest;
const payload = () =>
  VideoPlaybackAbrRequest.encode({
    initializationFormatIds: [],
    bufferedRanges: [],
    selectedAudioFormatIds: [],
    selectedVideoFormatIds: [],
    selectedCaptionFormatIds: [],
    ssapPlaybackInfos: [],
    field1000: [],
    videoPlaybackUstreamerConfig: new Uint8Array([1, 2]),
    streamerContext: {
      clientInfo: { clientName: 1, clientVersion: 'fixture' },
      poToken: new Uint8Array([3, 4]),
      sabrContexts: [],
      unsentSabrContexts: [],
    },
  }).finish();
beforeEach(() => {
  window.history.replaceState({}, '', '/watch?v=example');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('ok'))
  );
  vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => undefined);
  vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => undefined);
  cleanup = installObserver();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('observes a player fetch without changing its payload or response', async () => {
  const body = payload();
  const response = await window.fetch('https://r1.googlevideo.com/videoplayback?ump=1', {
    method: 'POST',
    body: body as BodyInit,
  });
  expect(await response.text()).toBe('ok');
  expect(state()?.session).toMatchObject({
    videoId: 'example',
    config: 'AQI=',
    token: 'AwQ=',
    clientInfo: { clientName: 1 },
  });
  expect([...body]).toEqual([...payload()]);
});
it('also observes XMLHttpRequest playback requests', () => {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', 'https://r1.googlevideo.com/videoplayback?ump=1');
  xhr.send(payload() as XMLHttpRequestBodyInit);
  expect(state()?.session?.videoId).toBe('example');
});
it('ignores unrelated destinations and unparseable payloads', async () => {
  await fetch('https://example.com/videoplayback', { method: 'POST', body: payload() as BodyInit });
  await fetch('https://r1.googlevideo.com/videoplayback', {
    method: 'POST',
    body: new Uint8Array([255]) as BodyInit,
  });
  expect(state()?.session).toBeUndefined();
});
it('clears the in-memory session on navigation and restores original APIs on cleanup', async () => {
  const observed = window.fetch;
  const duplicate = installObserver();
  duplicate();
  expect(window.fetch).toBe(observed);
  await fetch('https://r1.googlevideo.com/videoplayback', {
    method: 'POST',
    body: payload() as BodyInit,
  });
  window.dispatchEvent(new Event('yt-navigate-start'));
  expect(state()?.session).toBeUndefined();
  cleanup();
  expect(state()).toBeUndefined();
  expect(window.fetch).not.toBe(observed);
});
