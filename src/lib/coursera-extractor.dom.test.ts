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
it('keeps the course title separate from the subject and reads each outline group', () => {
  document.body.innerHTML =
    '<a href="/learn/machine-learning/home/welcome">Course name</a><h1>Current subject</h1><section><h3>Module 1</h3><div><h4>Group A</h4><ul><li><a href="/learn/machine-learning/lecture/a/one">Subject one</a></li></ul></div><div><h4>Group B</h4><ul><li><a href="/learn/machine-learning/lecture/b/two">Subject two</a></li></ul></div></section>';
  const result = CourseraExtractor.extractCourseStructure();
  expect(result.title).toBe('Course name');
  expect(
    result.sections.find((section: { title: string }) => section.title === 'Group A').lectures[0]
      .title
  ).toBe('Subject one');
  expect(
    result.sections.find((section: { title: string }) => section.title === 'Group B').lectures[0]
      .title
  ).toBe('Subject two');
});

it.each([
  ['assignment-submission/cKYHt/practice-quiz', 'quiz'],
  ['assignment-submission/VvXGH/graded-quiz', 'quiz'],
  ['supplement/oOixb/summary-and-highlights', 'article'],
])('recognizes the current Coursera route %s', async (path, kind) => {
  window.history.pushState({}, '', `/learn/machine-learning/${path}`);
  document.body.innerHTML = `<h1>Current item</h1><a href="/learn/machine-learning/${path}">Current item</a>`;
  expect(CourseraExtractor.getKind()).toBe(kind);
  expect(CourseraExtractor.getCurrentVideoInfo()?.videoId).not.toBe('unknown');
  await CourseraExtractor.loadAllItems(new AbortController().signal);
  const items = CourseraExtractor.extractCourseStructure().sections.flatMap(
    (section: { lectures: unknown[] }) => section.lectures
  );
  expect(items).toHaveLength(1);
  expect(items[0].kind).toBe(kind);
});

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
it('waits for reading content instead of saving its loading placeholder', async () => {
  vi.useFakeTimers();
  window.history.pushState({}, '', '/learn/machine-learning/supplement/notes/summary');
  document.body.innerHTML = '<div class="rc-CML">Loading</div>';
  const pending = CourseraExtractor.extractTranscript();
  await vi.advanceTimersByTimeAsync(2200);
  document.body.innerHTML = '<h1>Summary</h1><div class="rc-CML"><p>The actual reading.</p></div>';
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toContain('The actual reading.');
  expect(await pending).not.toContain('Loading');
});
it('reopens only a completed practice quiz through Try again and Continue without submitting', async () => {
  vi.useFakeTimers();
  const path = '/learn/machine-learning/assignment-submission/p1/practice-quiz';
  window.history.pushState({}, '', path);
  document.body.innerHTML =
    '<h1>Practice Quiz</h1><button>Try again</button><button>View feedback</button>';
  const submit = vi.fn();
  document.querySelector('button')!.onclick = () => {
    document.body.innerHTML +=
      '<div role="dialog"><h2>Start new attempt?</h2><p>When you submit a new attempt it will replace your previous submission.</p><button>Continue</button></div>';
    document.querySelector<HTMLButtonElement>('[role="dialog"] button')!.onclick = () => {
      window.history.pushState({}, '', `${path}/attempt`);
      document.body.innerHTML =
        '<h1>Practice Quiz</h1><div data-testid="question"><p>Sample question?</p><label><input type="radio">Option one</label></div><button>Submit</button>';
      document.querySelector('button')!.onclick = submit;
    };
  };
  const pending = CourseraExtractor.extractTranscript();
  await vi.advanceTimersByTimeAsync(3000);
  const text = await pending;
  expect(text).toContain('Sample question?');
  expect(text).toContain('Option one');
  expect(submit).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLInputElement>('input')!.checked).toBe(false);
});
it('does not reopen a graded assessment even when Try again is present', async () => {
  vi.useFakeTimers();
  window.history.pushState({}, '', '/learn/machine-learning/assignment-submission/g1/graded-quiz');
  document.body.innerHTML =
    '<h1>Graded Quiz</h1><button>Try again</button><button>View feedback</button>';
  const click = vi.fn();
  document.querySelector('button')!.onclick = click;
  const pending = CourseraExtractor.extractTranscript();
  const rejected = expect(pending).rejects.toThrow('No visible test questions');
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  expect(click).not.toHaveBeenCalled();
});
it('prefers Resume assignment and preserves unanswered and previously selected controls', async () => {
  vi.useFakeTimers();
  const path = '/learn/machine-learning/assignment-submission/p1/practice-quiz';
  window.history.pushState({}, '', path);
  document.body.innerHTML =
    '<h1>Practice Quiz</h1><button>Resume assignment</button><button>Try again</button>';
  const retry = vi.fn();
  document.querySelectorAll('button')[1].onclick = retry;
  document.querySelector('button')!.onclick = () => {
    window.history.pushState({}, '', `${path}/attempt`);
    document.body.innerHTML =
      '<div data-testid="question"><p>Existing question?</p><label><input type="radio" checked>Saved option</label><label><input type="radio">Other option</label></div><button>Submit</button>';
  };
  const pending = CourseraExtractor.extractTranscript();
  await vi.advanceTimersByTimeAsync(3000);
  expect(await pending).toContain('Existing question?');
  expect(retry).not.toHaveBeenCalled();
  expect(
    [...document.querySelectorAll<HTMLInputElement>('input')].map(input => input.checked)
  ).toEqual([true, false]);
});
it('includes the prompt referenced outside the option group and separates options', async () => {
  vi.useFakeTimers();
  window.history.pushState(
    {},
    '',
    '/learn/machine-learning/assignment-submission/p1/practice-quiz/attempt'
  );
  document.body.innerHTML =
    '<p id="prompt">Which item is correct?</p><div role="radiogroup" aria-labelledby="prompt"><label><input type="radio">First choice</label><label><input type="radio">Second choice</label></div>';
  const pending = CourseraExtractor.extractTranscript();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toContain('Which item is correct?\n\nFirst choice\nSecond choice');
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
