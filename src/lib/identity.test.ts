import { describe, expect, it } from 'vitest';
import { groupKey } from './identity';
import { courseIdFromUrl } from './library-schema';
import { collectionKey } from './collection';

describe('group identity', () => {
  it('groups lectures within a Coursera course', () => {
    const a = 'https://www.coursera.org/learn/math/lecture/a/intro';
    const b = 'https://www.coursera.org/learn/math/lecture/b/next';
    expect(groupKey(a)).toBe(groupKey(b));
    expect(groupKey(a)).toBe('https://www.coursera.org/learn/math');
  });
  it('keeps unrelated playlists and standalone videos separate', () => {
    expect(groupKey('https://www.youtube.com/watch?v=a&list=one')).toBe(
      'https://www.youtube.com/playlist?list=one'
    );
    expect(groupKey('https://www.youtube.com/watch?v=b&list=two')).not.toBe(
      groupKey('https://www.youtube.com/watch?v=a&list=one')
    );
    expect(groupKey('https://www.youtube.com/watch?v=a&t=10')).not.toBe(
      groupKey('https://www.youtube.com/watch?v=b')
    );
    expect(groupKey('https://youtu.be/a')).toBe(groupKey('https://www.youtube.com/watch?v=a'));
  });
  it('shares scope with the legacy collection adapter and retains Udemy behavior', () => {
    const url = 'https://tenant.udemy.com/course/math/learn/lecture/42#overview';
    expect(groupKey(url)).toBe('https://tenant.udemy.com/course/math');
    expect(collectionKey(url).slice('collection:'.length)).toBe(
      courseIdFromUrl(url).slice('course:'.length)
    );
  });
});
