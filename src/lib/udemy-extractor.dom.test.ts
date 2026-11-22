// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.udemy.com/course/deep-learning/learn/lecture/42" }

/**
 * The extractors had no tests at all, which is the wrong state for the most
 * fragile code in the project: every selector here is a guess about someone
 * else's markup, and Udemy is free to change it any Tuesday.
 *
 * What these fixtures encode is the *selector contract* the extractor depends
 * on — not captured Udemy HTML. So they cannot tell you Udemy still looks like
 * this. What they can tell you is that a refactor has not broken the parsing,
 * and exactly which selector a redesign invalidated. When extraction does break
 * against the real site, the fix is to re-capture the sidebar from a live
 * lecture page and update these fixtures to match.
 */

import capturedUntimed from './__fixtures__/udemy-untimed.html?raw';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { UdemyExtractor } from './udemy-extractor';

/** A sidebar in the shape the primary selectors expect. */
const SIDEBAR = `
  <h1 data-purpose="course-title">Deep Learning A–Z</h1>
  <div data-purpose="instructor-name">A. Teacher</div>

  <div data-purpose="section-panel-1">
    <div class="ud-accordion-panel-title">Section 1: Foundations</div>
    <div data-purpose="section-duration">0 / 2 | 38min</div>

    <div data-purpose="curriculum-item-1" class="curriculum-item-link--is-current--2mKk4">
      <span data-purpose="item-title">What gradient descent is</span>
      <div class="ud-text-xs"><span>Video</span><span>12min</span></div>
    </div>
    <div data-purpose="curriculum-item-2">
      <span data-purpose="item-title">Backpropagation</span>
      <div class="ud-text-xs"><span>Video</span><span>26min</span></div>
    </div>
  </div>

  <div data-purpose="section-panel-2">
    <div class="ud-accordion-panel-title">Section 2: Practice</div>
    <div data-purpose="section-duration">0 / 1 | 9min</div>

    <div data-purpose="curriculum-item-3">
      <span data-purpose="item-title">Your first network</span>
      <div class="ud-text-xs"><span>Video</span><span>9min</span></div>
    </div>
  </div>
`;

afterEach(() => {
  document.body.innerHTML = '';
  window.history.pushState({}, '', '/course/deep-learning/learn/lecture/42');
});

describe('isUdemyCoursePage', () => {
  it('recognises a lecture page', () => {
    expect(UdemyExtractor.isUdemyCoursePage()).toBe(true);
  });

  it('declines a Udemy page that is not a course', () => {
    // The popup gates extraction on this; a true here on the homepage would
    // offer to extract a transcript that cannot exist.
    window.history.pushState({}, '', '/');
    expect(UdemyExtractor.isUdemyCoursePage()).toBe(false);
  });
});

describe('isTranscriptAvailable', () => {
  it('sees a transcript that is already open', () => {
    document.body.innerHTML = '<div data-purpose="transcript-cue">Welcome back.</div>';
    expect(UdemyExtractor.isTranscriptAvailable()).toBe(true);
  });

  it('reports none on a page with neither cues nor a video', () => {
    document.body.innerHTML = '<div>Nothing to see</div>';
    expect(UdemyExtractor.isTranscriptAvailable()).toBe(false);
  });
});

describe('extractCourseStructure', () => {
  it('reads the course, its sections and their lectures in order', () => {
    document.body.innerHTML = SIDEBAR;

    const course = UdemyExtractor.extractCourseStructure();

    expect(course).not.toBeNull();
    expect(course?.title).toBe('Deep Learning A–Z');
    expect(course?.instructor).toBe('A. Teacher');
    expect(course?.sections).toHaveLength(2);

    expect(course?.sections[0].title).toBe('Section 1: Foundations');
    expect(course?.sections[0].lectures.map((l) => l.title)).toEqual([
      'What gradient descent is',
      'Backpropagation',
    ]);
    expect(course?.sections[1].lectures.map((l) => l.title)).toEqual(['Your first network']);
    expect(course?.sections[0].lectures[0]).toMatchObject({
      id: '1',
      url: 'https://www.udemy.com/course/deep-learning/learn/lecture/1',
    });
  });

  it('pulls the duration out of the counted section label', () => {
    // The label reads "0 / 2 | 38min" — the progress count has to be discarded
    // or the course shows "0" where a running time belongs.
    document.body.innerHTML = SIDEBAR;

    expect(UdemyExtractor.extractCourseStructure()?.sections[0].duration).toBe('38min');
  });

  it('marks which lecture is being watched', () => {
    document.body.innerHTML = SIDEBAR;

    const course = UdemyExtractor.extractCourseStructure();
    const current = course?.sections[0].lectures.filter((lecture) => lecture.isCurrent);

    expect(current?.map((lecture) => lecture.title)).toEqual(['What gradient descent is']);
    expect(course?.currentLecture?.title).toBe('What gradient descent is');
  });

  it('still finds lectures when only the links survive a redesign', () => {
    // The selector cascade exists for exactly this: `data-purpose` attributes
    // are Udemy's to rename, but a lecture is always a link to a lecture.
    document.body.innerHTML = `
      <h1 data-purpose="course-title">Deep Learning A–Z</h1>
      <div data-purpose="section-panel-1">
        <div class="ud-accordion-panel-title">Section 1: Foundations</div>
        <a href="/course/deep-learning/learn/lecture/42">What gradient descent is</a>
        <a href="/course/deep-learning/learn/lecture/43">Backpropagation</a>
      </div>
    `;

    const lectures = UdemyExtractor.extractCourseStructure()?.sections[0].lectures;

    expect(lectures).toHaveLength(2);
    expect(lectures?.map((lecture) => lecture.title)).toEqual([
      'What gradient descent is',
      'Backpropagation',
    ]);
  });

  it('returns a named course with no sections rather than throwing', () => {
    // A collapsed sidebar is an ordinary state, not an error. Returning null
    // here would make the popup report a broken page.
    document.body.innerHTML = '<h1 data-purpose="course-title">Deep Learning A–Z</h1>';

    const course = UdemyExtractor.extractCourseStructure();

    expect(course?.title).toBe('Deep Learning A–Z');
    expect(course?.sections).toEqual([]);
  });

  it('falls back to readable placeholders when the page says nothing', () => {
    const course = UdemyExtractor.extractCourseStructure();

    expect(course?.title).toBe('Untitled Course');
    expect(course?.instructor).toBe('Unknown Instructor');
  });
});

// Real DOM structure captured from the signed-in Business player; text sanitized.
describe('captured untimed captions', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  it('extracts the captured panel and marks duration-based timing as approximate', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<video></video>${capturedUntimed}`;
    const video = document.querySelector('video')!;
    Object.defineProperties(video, { readyState: { value: 4 }, duration: { value: 120 } });
    const pending = UdemyExtractor.extractTranscript();
    const assertion = expect(pending).resolves.toContain('<!-- timing: estimated -->');
    await vi.runAllTimersAsync();
    await assertion;
    const result = await pending;
    expect(result).toContain('<!-- timing: estimated -->');
    expect(result).toContain('First example caption.');
  });
});


it('uses the stable lecture ID from Udemy Business completion labels', () => {
  document.body.innerHTML = `<div data-purpose="section-panel-1">
    <div data-purpose="curriculum-item-0-0">
      <span id="item-completion-state-4689848">Completed</span>
      <span data-purpose="item-title">1. The Mind map course in a nutshell</span>
    </div>
  </div>`;
  expect(UdemyExtractor.extractCourseStructure()?.sections[0].lectures[0]).toMatchObject({
    id: '4689848',
    url: 'https://www.udemy.com/course/deep-learning/learn/lecture/4689848',
  });
});

it('reads the header and every chapter on a quiz page without including reminder panels', () => {
  window.history.pushState({}, '', '/course/deep-learning/learn/quiz/99');
  document.body.innerHTML = `
    <header><a class="course-header-title--title--abc">Mind map for Beginners</a></header>
    <section data-purpose="learning-section"><h2>Learning reminders</h2></section>
    <div class="section--panel--abc">
      <h3 class="section--section-title--abc">Introduction</h3>
      <div data-purpose="curriculum-item-0-0">
        <span id="item-completion-state-101"></span>
        <span data-purpose="item-title">First video</span>
        <svg><use xlink:href="#icon-video"></use></svg>
      </div>
      <div data-purpose="curriculum-item-0-1">
        <span id="item-completion-state-99"></span>
        <span data-purpose="item-title">Quiz</span>
        <svg><use xlink:href="#icon-quiz"></use></svg>
      </div>
    </div>
    <div class="section--panel--abc">
      <h3 class="section--section-title--abc">Practice</h3>
      <div class="section--section-content--abc"><div class="curriculum-item-link--curriculum-item--abc">
        <a href="/course/deep-learning/learn/lecture/202"><span data-purpose="item-title">Second video</span></a>
      </div></div>
    </div>`;
  const result = UdemyExtractor.extractCourseStructure();
  expect(result?.title).toBe('Mind map for Beginners');
  expect(result?.sections.map(section => section.title)).toEqual(['Introduction', 'Practice']);
  expect(result?.sections.flatMap(section => section.lectures).map(item => [item.id, item.kind]))
    .toEqual([['101', 'video'], ['99', 'quiz'], ['202', 'video']]);
});

it('keeps items without numeric IDs distinct across chapters', () => {
  document.body.innerHTML = [0, 1].map(index => `
    <div data-purpose="section-panel-${index}">
      <div data-purpose="curriculum-item-${index}-0"><span data-purpose="item-title">Video ${index}</span></div>
    </div>`).join('');
  const ids = UdemyExtractor.extractCourseStructure()?.sections.flatMap(section => section.lectures.map(item => item.id));
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
});

it('expands collapsed chapters before reading their items', async () => {
  vi.useFakeTimers();
  try {
    document.body.innerHTML = `<div class="section--panel--abc"><h3>Practice</h3><button aria-expanded="false">Open</button></div>`;
    const button = document.querySelector('button')!;
    button.addEventListener('click', () => {
      button.setAttribute('aria-expanded', 'true');
      button.insertAdjacentHTML('afterend', '<div data-purpose="curriculum-item-101"><span data-purpose="item-title">Hidden video</span></div>');
    });
    const pending = UdemyExtractor.expandAllSections();
    await vi.runAllTimersAsync();
    await pending;
    expect(UdemyExtractor.extractCourseStructure()?.sections[0].lectures[0].title).toBe('Hidden video');
  } finally {
    vi.useRealTimers();
  }
});
it('waits for a delayed sidebar and expands role-based headers without opening resource menus', async () => {
  vi.useFakeTimers();
  try {
    document.body.innerHTML = '';
    setTimeout(() => {
      document.body.innerHTML = `<div class="accordion-panel-module--panel"><div role="button" aria-expanded="false"><h3>Introduction</h3></div></div>`;
      const header = document.querySelector('[role="button"]')!;
      header.addEventListener('click', () => {
        header.setAttribute('aria-expanded', 'true');
        header.insertAdjacentHTML('afterend', '<div data-purpose="curriculum-item-101"><span data-purpose="item-title">Video</span><button aria-expanded="false">Resources</button></div>');
      });
    }, 250);
    const loading = UdemyExtractor.loadAllItems(new AbortController().signal);
    await vi.runAllTimersAsync(); await loading;
    expect(UdemyExtractor.extractCourseStructure()?.sections[0].lectures).toHaveLength(1);
    expect(document.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
  } finally { vi.useRealTimers(); }
});

it('reads visible cue text in the sidebar without toggling the open transcript closed', async () => {
  vi.useFakeTimers();
  try {
    document.body.innerHTML = `<video></video><button data-purpose="transcript-toggle" aria-expanded="true">Transcript</button>
      <div data-purpose="sidebar-content"><span data-purpose="cue-text">Caption already visible.</span></div>`;
    Object.defineProperties(document.querySelector('video')!, { readyState: { value: 4 }, duration: { value: 120 } });
    const click = vi.fn();
    document.querySelector('button')!.addEventListener('click', click);
    const pending = UdemyExtractor.extractTranscript();
    await vi.runAllTimersAsync();
    expect(await pending).toContain('Caption already visible.');
    expect(click).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('opens the transcript and waits for delayed cue rows before reading it', async () => {
  vi.useFakeTimers();
  try {
    document.body.innerHTML = `<video></video><button data-purpose="transcript-toggle">Transcript</button>`;
    Object.defineProperties(document.querySelector('video')!, { readyState: { value: 4 }, duration: { value: 120 } });
    const button = document.querySelector('button')!;
    Object.defineProperty(button, 'offsetParent', { get: () => document.body });
    button.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', '<div data-purpose="transcript-panel"></div>');
      setTimeout(() => {
        document.querySelector('[data-purpose="transcript-panel"]')!.innerHTML = '<p data-purpose="transcript-cue">Caption loaded after navigation.</p>';
      }, 3000);
    });
    const pending = UdemyExtractor.extractTranscript();
    await vi.runAllTimersAsync();
    expect(await pending).toContain('Caption loaded after navigation.');
  } finally { vi.useRealTimers(); }
});
