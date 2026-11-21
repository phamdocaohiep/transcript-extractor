// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.youtube.com/watch?v=example" }
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readStreams, selectStreams, type StreamInfo } from './stream-discovery';
const base =
  'https://r1---sn-test.googlevideo.com/videoplayback?id=media&itag=137&clen=100&sig=keep';
let response: Record<string, unknown>;
beforeEach(() => {
  window.history.replaceState({}, '', '/watch?v=example');
  response = {
    videoDetails: { videoId: 'example', title: 'An example' },
    playabilityStatus: { status: 'OK' },
  };
  document.body.innerHTML = '<div id="movie_player"></div>';
  Object.assign(document.getElementById('movie_player')!, { getPlayerResponse: () => response });
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});
it('reads a complete progressive stream from the current signed-in player', () => {
  response.streamingData = {
    formats: [
      { itag: 137, url: base, mimeType: 'video/mp4; codecs="avc1.64001f, mp4a.40.2"', height: 720 },
    ],
  };
  const result = readStreams();
  expect(result.title).toBe('An example');
  expect(result.streams[0]).toMatchObject({ video: true, audio: true, size: 100 });
  expect(selectStreams(result.streams)?.extension).toBe('mp4');
});
it('uses the player-transformed request for a ciphered format without evaluating remote scripts', () => {
  response.streamingData = {
    adaptiveFormats: [
      {
        itag: 137,
        signatureCipher: new URLSearchParams({ url: `${base}&n=raw`, s: 'ciphered' }).toString(),
        mimeType: 'video/mp4; codecs="avc1.640028"',
      },
    ],
  };
  vi.mocked(performance.getEntriesByType).mockReturnValue([
    { name: `${base}&n=transformed&pot=session&range=0-49` } as PerformanceResourceTiming,
  ]);
  const url = new URL(readStreams().streams[0].url);
  expect(url.searchParams.get('n')).toBe('transformed');
  expect(url.searchParams.get('pot')).toBe('session');
  expect(url.searchParams.get('sig')).toBe('keep');
  expect(url.searchParams.has('range')).toBe(false);
});
it('does not invent signatures or use requests from another media ID', () => {
  response.streamingData = {
    adaptiveFormats: [
      {
        itag: 137,
        signatureCipher: new URLSearchParams({ url: `${base}&n=raw`, s: 'ciphered' }).toString(),
        mimeType: 'video/mp4',
      },
    ],
  };
  vi.mocked(performance.getEntriesByType).mockReturnValue([
    { name: base.replace('id=media', 'id=previous') } as PerformanceResourceTiming,
  ]);
  expect(readStreams().streams).toEqual([]);
});
it('rejects stale player data after playlist navigation', () => {
  window.history.replaceState({}, '', '/watch?v=next');
  response.streamingData = { formats: [{ itag: 137, url: base, mimeType: 'video/mp4' }] };
  expect(readStreams().streams).toEqual([]);
});
it('reports the signed-in player availability rather than attempting restricted videos', () => {
  response.playabilityStatus = { status: 'LOGIN_REQUIRED', reason: 'Sign in to view this video' };
  expect(readStreams().unavailable).toBe('Sign in to view this video');
});
it('rejects DRM and live broadcasts', () => {
  response.streamingData = { licenseInfos: [{}] };
  expect(readStreams().unavailable).toContain('DRM');
  response.streamingData = {};
  response.videoDetails = { videoId: 'example', isLiveContent: true };
  expect(readStreams().unavailable).toContain('Live');
});
it('does not expand a byte range that is covered by the signed URL', () => {
  response.streamingData = {
    formats: [{ itag: 137, url: `${base}&range=0-49&sparams=id,range`, mimeType: 'video/mp4' }],
  };
  expect(readStreams().streams).toEqual([]);
});
it('does not accept arbitrary page-supplied download hosts', () => {
  response.streamingData = {
    formats: [{ itag: 137, url: 'https://example.com/videoplayback', mimeType: 'video/mp4' }],
  };
  expect(readStreams().streams).toEqual([]);
});
const stream = (overrides: Partial<StreamInfo>): StreamInfo => ({
  url: base,
  mimeType: 'video/mp4; codecs="avc1.640028"',
  video: true,
  audio: false,
  height: 1080,
  bitrate: 1e6,
  ...overrides,
});
it('selects the highest AVC video plus matching audio rather than saving a silent track', () => {
  const video = stream({});
  const audio = stream({
    mimeType: 'audio/mp4; codecs="mp4a.40.2"',
    video: false,
    audio: true,
    height: 0,
  });
  const result = selectStreams([stream({ audio: true, height: 360 }), video, audio]);
  expect(result).toEqual({ video, audio, extension: 'mp4' });
  expect(selectStreams([video])).toBeNull();
});
it('keeps VP9 and Opus in a WebM container', () => {
  const video = stream({ mimeType: 'video/webm; codecs="vp9"' });
  const audio = stream({ mimeType: 'audio/webm; codecs="opus"', video: false, audio: true });
  expect(selectStreams([video, audio])).toEqual({ video, audio, extension: 'webm' });
});

it('accepts AV1 video and the Opus audio exposed by the same player', () => {
  const video = stream({ mimeType: 'video/mp4; codecs="av01.0.08M.08"' });
  const audio = stream({ mimeType: 'audio/webm; codecs="opus"', video: false, audio: true });
  expect(selectStreams([video, audio])).toEqual({ video, audio, extension: 'mp4' });
});

it('reports SABR-only delivery instead of saving an UMP response as video', () => {
  response.streamingData = {
    serverAbrStreamingUrl: 'https://r1.googlevideo.com/videoplayback?ump=1',
  };
  // Allow the recovery loop to prime/reload before declaring missing streams.
  expect(readStreams().unavailable).toBeUndefined();
  expect(readStreams().streams).toEqual([]);
});
