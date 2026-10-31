// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.coursera.org/learn/machine-learning/lecture/abc123/gradient-descent" }

/**
 * Detection is the gate everything else sits behind: the popup decides whether
 * to offer extraction from this, so a wrong answer either hides the feature on
 * a page that supports it or offers it on one that cannot.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { CourseraExtractor } from './coursera-extractor';

const LECTURE = '/learn/machine-learning/lecture/abc123/gradient-descent';

afterEach(() => {
  window.history.pushState({}, '', LECTURE);
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
  afterEach(() => { document.body.innerHTML = ''; });
  it('keeps untimed phrases untimed rather than inventing five-minute offsets', async () => {
    document.body.innerHTML = '<div class="rc-Paragraph"><span class="rc-Phrase">First</span><span class="rc-Phrase">Second</span></div>';
    const result = await CourseraExtractor.extractTranscript();
    expect(result).toBe('First\n\nSecond');
  });
  it('emits canonical source timestamps that the shared parser can read', async () => {
    document.body.innerHTML = '<div class="rc-Paragraph"><span class="timestamp">01:23</span><span class="rc-Phrase">Caption</span></div>';
    expect(await CourseraExtractor.extractTranscript()).toBe('[01:23] Caption');
  });
});
