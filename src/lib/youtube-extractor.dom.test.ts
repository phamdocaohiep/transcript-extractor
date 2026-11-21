// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.youtube.com/watch?v=aaaaaaaaaaa" }

/**
 * Detection is the gate everything else sits behind: the popup decides whether
 * to offer extraction from this, so a wrong answer either hides the feature on
 * a page that supports it or offers it on one that cannot.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { YouTubeExtractor } from './youtube-extractor';

afterEach(() => {
  window.history.pushState({}, '', '/watch?v=aaaaaaaaaaa');
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const baseUrl = 'https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa&lang=en&sig=kept';

function addMetadata(
  tracks: Array<{ baseUrl: string; languageCode: string; kind?: string }> = [
    { baseUrl, languageCode: 'en' },
  ],
  videoId = 'aaaaaaaaaaa'
): string {
  const script = document.createElement('script');
  script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify({
    videoDetails: { videoId, title: 'A title with } and " characters' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
  })}; window.otherData = {};`;
  document.body.append(script);
  return script.outerHTML;
}

describe('caption extraction', () => {
  it('detects embedded captions without a transcript button', () => {
    addMetadata();
    expect(YouTubeExtractor.isTranscriptAvailable()).toBe(true);
  });

  it('extracts timed text and preserves signed URL parameters', async () => {
    addMetadata();
    const request = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          events: [
            { tStartMs: 1000, segs: [{ utf8: 'Hello ' }, { utf8: 'world\nagain' }] },
            { tStartMs: 3661000, segs: [{ utf8: 'Next' }] },
            { tStartMs: 2000, segs: [{ utf8: '\n' }] },
            { tStartMs: -1, segs: [{ utf8: 'Invalid' }] },
            { tStartMs: 3000 },
            null,
          ],
        }),
      });
    vi.stubGlobal('fetch', request);
    expect(await YouTubeExtractor.extractTranscript()).toBe(
      '[00:01] Hello world again\n\n[1:01:01] Next'
    );
    const url = new URL(request.mock.calls[0][0]);
    expect(url.searchParams.get('fmt')).toBe('json3');
    expect(url.searchParams.get('sig')).toBe('kept');
    expect(request.mock.calls[0][1].credentials).toBe('include');
  });

  it('prefers manual Vietnamese over auto-generated captions', async () => {
    addMetadata([
      { baseUrl: `${baseUrl}&kind=asr`, languageCode: 'en', kind: 'asr' },
      { baseUrl: `${baseUrl}&manual=1`, languageCode: 'vi' },
    ]);
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        events: [{ tStartMs: 0, segs: [{ utf8: 'Caption' }] }],
      }),
    });
    vi.stubGlobal('fetch', request);
    await YouTubeExtractor.extractTranscript();
    expect(new URL(request.mock.calls[0][0]).searchParams.get('manual')).toBe('1');
  });

  it('fetches current metadata after playlist navigation instead of using stale captions', async () => {
    const current = addMetadata();
    document.body.innerHTML = '';
    addMetadata(
      [{ baseUrl: baseUrl.replace('aaaaaaaaaaa', 'bbbbbbbbbbb'), languageCode: 'en' }],
      'bbbbbbbbbbb'
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => current })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ events: [{ tStartMs: 0, segs: [{ utf8: 'Current' }] }] }),
      });
    vi.stubGlobal('fetch', request);
    expect(await YouTubeExtractor.extractTranscript()).toBe('[00:00] Current');
    expect(request.mock.calls[0][0]).toBe('/watch?v=aaaaaaaaaaa');
  });

  it('does not accept unrelated caption hosts or mismatched video IDs', () => {
    addMetadata([
      { baseUrl: 'https://example.com/api/timedtext?v=aaaaaaaaaaa', languageCode: 'en' },
      { baseUrl: baseUrl.replace('aaaaaaaaaaa', 'bbbbbbbbbbb'), languageCode: 'en' },
    ]);
    expect(YouTubeExtractor.isTranscriptAvailable()).toBe(false);
  });

  it.each(['network', 'empty', 'invalid'])(
    'falls back to panel extraction on %s caption responses',
    async failure => {
      vi.useFakeTimers();
      addMetadata();
      const request = vi.fn();
      if (failure === 'network') request.mockRejectedValue(new Error('Network unavailable'));
      else
        request.mockResolvedValue({
          ok: true,
          json: async () => (failure === 'empty' ? { events: [] } : { events: 'invalid' }),
        });
      vi.stubGlobal('fetch', request);
      const panel = document.createElement('div');
      panel.id = 'segments-container';
      panel.innerHTML =
        '<ytd-transcript-segment-renderer><span class="segment-timestamp">0:02</span><span class="segment-text">Panel caption</span></ytd-transcript-segment-renderer>';
      document.body.append(panel);
      const extraction = YouTubeExtractor.extractTranscript();
      await vi.runAllTimersAsync();
      expect(await extraction).toContain('[0:02] Panel caption');
    }
  );

  it('reports unavailable captions when metadata and panel extraction both fail', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const result = expect(YouTubeExtractor.extractTranscript()).rejects.toThrow(
      'No captions available for this YouTube video, or the video is restricted for this browser session.'
    );
    await vi.runAllTimersAsync();
    await result;
  });
});

describe('isYouTubeVideoPage', () => {
  it('recognises a watch page', () => {
    expect(YouTubeExtractor.isYouTubeVideoPage()).toBe(true);
  });

  it('still recognises it with a playlist and a start time attached', () => {
    window.history.pushState({}, '', '/watch?v=aaaaaaaaaaa&list=PL123&t=90s');
    expect(YouTubeExtractor.isYouTubeVideoPage()).toBe(true);
  });

  it('declines the parts of YouTube that are not a video', () => {
    for (const path of ['/', '/feed/subscriptions', '/results?search_query=gradient']) {
      window.history.pushState({}, '', path);
      expect(YouTubeExtractor.isYouTubeVideoPage()).toBe(false);
    }
  });
});

it('does not treat the captured no-captions button as available captions', async () => {
  const { default: markup } = await import('./__fixtures__/youtube-no-captions.html?raw');
  document.body.innerHTML = markup;
  expect(YouTubeExtractor.isTranscriptAvailable()).toBe(false);
});

it('recognizes Shorts and reads its identifier', () => {
  window.history.replaceState({}, '', '/shorts/shortExample');
  document.body.innerHTML = '<h1>A short example</h1>';
  expect(YouTubeExtractor.isYouTubeVideoPage()).toBe(true);
  expect(YouTubeExtractor.getCurrentVideoInfo()?.videoId).toBe('shortExample');
});

it('retains the active playlist when video links omit its list parameter', () => {
  window.history.replaceState({}, '', '/watch?list=PL123&v=aaaaaaaaaaa');
  document.body.innerHTML = `<ytd-playlist-panel-renderer>
    <ytd-playlist-panel-video-renderer><a href="/watch?v=bbbbbbbbbbb"><span id="video-title">Second item</span></a></ytd-playlist-panel-video-renderer>
  </ytd-playlist-panel-renderer>`;
  const item = YouTubeExtractor.extractPlaylist()?.videos[0];
  expect(item?.videoId).toBe('bbbbbbbbbbb');
  expect(new URL(item!.url).searchParams.get('list')).toBe('PL123');
});
