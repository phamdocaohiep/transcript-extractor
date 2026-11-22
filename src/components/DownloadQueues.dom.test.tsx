// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DownloadQueues } from './DownloadQueues';
import type { QueueState } from './VideoDownload';

let mounted: Set<number>;
let stopped: number[];
let totals: Record<number, number>;
vi.mock('./VideoDownload', () => ({
  VideoDownload: function Worker({
    sourceTabId: id,
    active,
    settingsLocked,
    onStateChange,
  }: {
    sourceTabId: number;
    active: boolean;
    settingsLocked: boolean;
    onStateChange: (id: number, state: QueueState) => void;
  }) {
    const [status, setStatus] = useState('Ready');
    const total = totals[id] ?? 2;
    useEffect(() => {
      mounted.add(id);
      return () => {
        mounted.delete(id);
        stopped.push(id);
      };
    }, [id]);
    useEffect(
      () =>
        onStateChange(id, {
          busy: status === 'Downloading',
          needsAccess: status === 'Permission',
          title: `Source ${id}`,
          saved: 0,
          total,
          error: false,
        }),
      [id, status, total, onStateChange]
    );
    return (
      <section aria-label={`Worker ${id}`} data-active={active} data-locked={settingsLocked}>
        <p>{status}</p>
        <button onClick={() => setStatus('Downloading')}>Start {id}</button>
        <button onClick={() => setStatus('Permission')}>Pause {id}</button>
        <button onClick={() => setStatus('Ready')}>Cancel {id}</button>
      </section>
    );
  },
}));

let root: Root;
let container: HTMLDivElement;
let active: number;
let activated: () => void;
let created: () => void;
let updated: (id: number, info: { status: 'complete' }, tab: { active: boolean }) => void;
let removed: (id: number) => void;
let tabs: Array<{ id: number; url: string; title: string }>;
let onBusy: ReturnType<typeof vi.fn<(busy: boolean) => void>>;
beforeEach(() => {
  totals = {};
  mounted = new Set();
  stopped = [];
  active = 1;
  tabs = [
    { id: 1, url: 'https://www.youtube.com/watch?v=first', title: 'First' },
    { id: 2, url: 'https://www.youtube.com/watch?v=second', title: 'Second' },
    { id: 3, url: 'https://www.udemy.com/course/example/learn/lecture/1', title: 'Third' },
    { id: 4, url: 'https://example.com', title: 'Unrelated' },
  ];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => tabs.map(tab => ({ ...tab, active: tab.id === active }))),
      onActivated: {
        addListener: vi.fn(listener => (activated = listener)),
        removeListener: vi.fn(),
      },
      onUpdated: { addListener: vi.fn(listener => (updated = listener)), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(listener => (created = listener)), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(listener => (removed = listener)), removeListener: vi.fn() },
    },
  });
  onBusy = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<DownloadQueues screen="main" onBusyChange={onBusy} />));
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(
    button => button.textContent === text
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function select(id: number) {
  active = id;
  await act(async () => activated());
}

it('keeps a paused source mounted while another YouTube tab and an Udemy tab start independent queues', async () => {
  await render();
  await click('Start 1');
  await select(2);
  await click('Start 2');
  await select(3);
  await click('Start 3');
  expect([...mounted]).toEqual([1, 2, 3]);
  expect(stopped).toEqual([]);
  expect(onBusy).toHaveBeenLastCalledWith(true);
  await click('Pause 1');
  expect(container.textContent).toContain('Waiting for permission');
  const first = container.querySelector('[aria-label="Worker 1"]')!;
  expect(first.closest('[hidden]')).not.toBeNull();
  const button = [...container.querySelectorAll('button')].find(button =>
    button.textContent?.includes('Source 1')
  )!;
  await act(async () => button.click());
  expect(first.closest('[hidden]')).toBeNull();
  expect(first.textContent).toContain('Permission');
  expect(first.getAttribute('data-locked')).toBe('true');
  await click('Cancel 2');
  expect(onBusy).toHaveBeenLastCalledWith(true);
  await click('Cancel 3');
  expect(onBusy).toHaveBeenLastCalledWith(false);
  expect(stopped).toEqual([]);
});

it('adds supported open tabs once and stops only the worker whose source tab closes', async () => {
  await render();
  await select(1);
  await select(1);
  expect(container.textContent).not.toContain('Add open tabs');
  expect([...mounted]).toEqual([1, 2, 3]);
  await click('Start 1');
  await click('Start 2');
  await act(async () => removed(1));
  expect([...mounted]).toEqual([2, 3]);
  expect(stopped).toEqual([1]);
  expect(container.textContent).toContain('Tab closed — stopped');
  expect(onBusy).toHaveBeenLastCalledWith(true);
});

it('does not discard queues when switching to an unsupported tab', async () => {
  await render();
  await click('Start 1');
  await select(4);
  expect([...mounted]).toEqual([1, 2, 3]);
  expect(stopped).toEqual([]);
  expect(container.querySelector('[aria-label="Worker 1"]')?.closest('[hidden]')).toBeNull();
});
it('shows single videos directly above series queues without remounting their workers', async () => {
  totals[1] = 1;
  await render();
  expect(stopped).toEqual([]);
  const first = container.querySelector('[aria-label="Worker 1"]')!;
  expect(first.closest('[hidden]')).toBeNull();
  const switcher = container.querySelector('[aria-label="Download queues"]')!;
  expect(switcher.textContent).not.toContain('Source 1');
  expect(switcher.textContent).toContain('Source 2');
  expect(first.compareDocumentPosition(switcher) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await click('Start 1');
  await select(2);
  expect(first.closest('[hidden]')).toBeNull();
  expect(stopped).toEqual([]);
  expect(onBusy).toHaveBeenLastCalledWith(true);
});
it('automatically registers a new background video tab after its URL is ready', async () => {
  await render();
  tabs.push({ id: 5, url: 'about:blank', title: 'Loading' });
  await act(async () => created());
  expect(mounted.has(5)).toBe(false);
  tabs[4] = { id: 5, url: 'https://www.youtube.com/watch?v=new', title: 'New video' };
  await act(async () => updated(5, { status: 'complete' }, { active: false }));
  expect(mounted.has(5)).toBe(true);
  expect(container.querySelector('[aria-label="Worker 1"]')?.closest('[hidden]')).toBeNull();
});
it('closes only the requested queue, keeps its source tab open and suppresses rediscovery until its URL changes', async () => {
  await render();
  await click('Start 1');
  await click('Start 2');
  const close = container.querySelector<HTMLButtonElement>('[aria-label="Close queue: Source 1"]')!;
  await act(async () => close.click());
  expect(stopped).toEqual([1]);
  expect(mounted.has(2)).toBe(true);
  expect(tabs.some(tab => tab.id === 1)).toBe(true);
  await select(1);
  expect(mounted.has(1)).toBe(false);
  tabs[0].url = 'https://www.youtube.com/watch?v=new';
  await act(async () => updated(1, { status: 'complete' }, { active: true }));
  expect(mounted.has(1)).toBe(true);
});
it('keeps workers running when the main view is hidden for search or switched to settings', async () => {
  await render();
  await click('Start 1');
  await act(async () =>
    root.render(<DownloadQueues screen="settings" visible={false} onBusyChange={onBusy} />)
  );
  expect(stopped).toEqual([]);
  expect(container.querySelector('[aria-label="Worker 1"]')?.getAttribute('data-active')).toBe(
    'false'
  );
  await act(async () => root.render(<DownloadQueues screen="main" onBusyChange={onBusy} />));
  expect(stopped).toEqual([]);
  expect(container.querySelector('[aria-label="Worker 1"]')!.textContent).toContain('Downloading');
});
