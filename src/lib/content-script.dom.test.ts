// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.udemy.com/course/test/learn/lecture/1" }
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { BatchItem } from './batch-service';

vi.mock('./quick-note', () => ({ installQuickNote: vi.fn() }));
vi.mock('./batch-service', () => ({
  getBatchState: vi.fn(async () => null),
  setBatchState: vi.fn(),
}));
let content: {
  navigateToBatchItem(item: BatchItem): Promise<boolean>;
  handleMessage(message: { type: string }, respond: (value: unknown) => void): Promise<void>;
};
beforeAll(async () => {
  vi.stubGlobal('chrome', { runtime: { onMessage: { addListener: vi.fn() } } });
  await import('./content-script');
  content = window.transcriptExtractorContentScript as unknown as typeof content;
});
beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState({}, '', '/course/test/learn/lecture/1');
  document.body.innerHTML =
    '<aside><div data-purpose="curriculum-item-entry"><span data-purpose="item-title">学习课程</span></div></aside>';
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});
it('collects a lecture with a fallback ID and non-Latin title after successful navigation', async () => {
  document.querySelector('[data-purpose="item-title"]')!.addEventListener('click', () => {
    window.history.pushState({}, '', '/course/test/learn/lecture/2');
  });
  const result = content.navigateToBatchItem({
    id: 'lecture-0',
    title: '学习课程',
    status: 'pending',
  });
  // Synchronous SPA navigation must be detected without waiting for the timeout.
  await expect(result).resolves.toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it('does not treat a click that leaves the lecture unchanged as a successful navigation', async () => {
  const result = content.navigateToBatchItem({
    id: 'lecture-0',
    title: '学习课程',
    status: 'pending',
  });
  await vi.runAllTimersAsync();
  await expect(result).resolves.toBe(false);
});

it('never clicks the play button when preparing a download', async () => {
  document.body.innerHTML = '<button data-purpose="video-play-button">Play</button>';
  const click = vi.fn();
  document.querySelector('button')!.addEventListener('click', click);
  const respond = vi.fn();
  await content.handleMessage({ type: 'PREPARE_DOWNLOAD' }, respond);
  expect(click).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith({ success: true });
});
