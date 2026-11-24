// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.coursera.org/learn/machine-learning/lecture/abc123/gradient-descent" }

/**
 * Detection is the gate everything else sits behind: the popup decides whether
 * to offer extraction from this, so a wrong answer either hides the feature on
 * a page that supports it or offers it on one that cannot.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { CourseraExtractor } from './coursera-extractor';

const LECTURE = '/learn/machine-learning/lecture/abc123/gradient-descent';

afterEach(() => {
  window.history.pushState({}, '', LECTURE);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it('discovers all linked modules in order, retaining videos, readings, practice and final tests', async () => {
  document.body.innerHTML = `<h1>Course</h1><a href="/learn/machine-learning/home/module/1">Module 1</a>`;
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(
        url.endsWith('/1')
          ? `<section><h2>Module 1</h2><a href="/learn/machine-learning/lecture/v1/video">Video</a><a href="/learn/machine-learning/reading/r1/notes">Reading</a></section><a href="/learn/machine-learning/home/module/2">Module 2</a>`
          : `<section><h2>Module 2</h2><a href="/learn/machine-learning/quiz/q1/practice">Practice test</a><a href="/learn/machine-learning/exam/e1/final">Final test</a><a href="/learn/machine-learning/lecture/v2/locked" aria-disabled="true">Locked</a><a href="/learn/other/lecture/x/other">Other course</a></section>`
      )
  );
  vi.stubGlobal('fetch', fetcher);
  await CourseraExtractor.loadAllItems(new AbortController().signal);
  const result = CourseraExtractor.extractCourseStructure();
  const items = result.sections.flatMap((section: { lectures: unknown[] }) => section.lectures);
  expect(items.map((item: { kind: string }) => item.kind)).toEqual([
    'video',
    'article',
    'quiz',
    'quiz',
    'video',
    'video',
  ]);
  expect(items.find((item: { title: string }) => item.title === 'Locked').available).toBe(false);
  expect(JSON.stringify(result)).not.toContain('/learn/other/');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(([url]) => /\/home\//.test(url))).toBe(true);
});
it('exports only visible test questions and never clicks start/submit or reveals hidden answers', async () => {
  vi.useFakeTimers();
  window.history.pushState({}, '', '/learn/machine-learning/quiz/practice/check');
  document.body.innerHTML = `<main><h1>Practice</h1><button>Start attempt</button><div data-testid="question"><p>Which option?</p><label><input type="radio">Option A</label><label><input type="radio">Option B</label><span hidden>Correct answer secret</span><textarea>Private response</textarea><button>Submit</button></div></main>`;
  const clicks = vi.fn();
  document.querySelectorAll('button').forEach(button => button.addEventListener('click', clicks));
  const reading = CourseraExtractor.extractTranscript();
  await vi.advanceTimersByTimeAsync(2000);
  const text = await reading;
  expect(text).toContain('Question 1');
  expect(text).toContain('Option A');
  expect(text).not.toContain('secret');
  expect(text).not.toContain('Private response');
  expect(clicks).not.toHaveBeenCalled();
});
it('reports unopened or locked assessment content as unavailable without beginning an attempt', async () => {
  vi.useFakeTimers();
  window.history.pushState({}, '', '/learn/machine-learning/exam/final/check');
  document.body.innerHTML = '<main><h1>Final</h1><button>Start exam</button></main>';
  const pending = CourseraExtractor.extractTranscript();
  const rejected = expect(pending).rejects.toThrow('will not start or submit');
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
});
it('discovers only HTTPS video/audio links actually exposed by the page', () => {
  document.body.innerHTML =
    '<video src="https://cdn.test/video.mp4"></video><audio src="https://cdn.test/audio.m4a"></audio><div class="rc-Downloads"><a href="https://cdn.test/audio.mp3">Audio</a><a href="javascript:void(0)">Bad</a></div>';
  expect(CourseraExtractor.getSources()).toEqual(['https://cdn.test/video.mp4']);
  expect(CourseraExtractor.getAudioSources()).toEqual([
    'https://cdn.test/audio.m4a',
    'https://cdn.test/audio.mp3',
  ]);
});
it('reads an exposed caption file with its real timestamps without starting playback', async () => {
  vi.useFakeTimers();
  document.body.innerHTML =
    '<video><track kind="subtitles" src="https://cdn.test/subs.vtt"></video>';
  const fetcher = vi.fn(
    async () => new Response('WEBVTT\n\n00:00:12.000 --> 00:00:14.000\nCaption from track.')
  );
  vi.stubGlobal('fetch', fetcher);
  const pending = CourseraExtractor.extractTranscript();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toBe('[00:12] Caption from track.');
  expect(fetcher).toHaveBeenCalledWith(
    'https://cdn.test/subs.vtt',
    expect.objectContaining({ redirect: 'error' })
  );
});

describe('isCourseraCoursePage', () => {
  it('recognises a lecture page', () => {
    expect(CourseraExtractor.isCourseraCoursePage()).toBe(true);
  });

  it('recognises a reading, which is course content with no video', () => {
    window.history.pushState({}, '', '/learn/machine-learning/reading/xyz789/notes');
    expect(CourseraExtractor.isCourseraCoursePage()).toBe(true);
  });

  it('declines the parts of Coursera that are not course content', () => {
    for (const path of ['/', '/browse', '/degrees']) {
      window.history.pushState({}, '', path);
      expect(CourseraExtractor.isCourseraCoursePage()).toBe(false);
    }
  });
});

// These are deliberately synthetic regression cases; no live Coursera fixture is available yet.
describe('caption timing', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });
  it('keeps untimed phrases untimed rather than inventing five-minute offsets', async () => {
    document.body.innerHTML =
      '<div class="rc-Paragraph"><span class="rc-Phrase">First</span><span class="rc-Phrase">Second</span></div>';
    const result = await CourseraExtractor.extractTranscript();
    expect(result).toBe('First\n\nSecond');
  });
  it('emits canonical source timestamps that the shared parser can read', async () => {
    document.body.innerHTML =
      '<div class="rc-Paragraph"><span class="timestamp">01:23</span><span class="rc-Phrase">Caption</span></div>';
    expect(await CourseraExtractor.extractTranscript()).toBe('[01:23] Caption');
  });
});
