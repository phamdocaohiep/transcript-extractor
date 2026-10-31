import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { handleBatchRequest } from './batch-controller';
import { BATCH_STORAGE_KEY, type BatchState } from './batch-service';
const url = 'https://www.udemy.com/course/test/learn/lecture/1';
const tab = { id: 1, url } as chrome.tabs.Tab;
let store: Record<string, unknown>;
function state(): BatchState {
  return {
    runId: 'one',
    isActive: true,
    isPaused: false,
    courseTitle: 'Test',
    courseUrl: url,
    items: [{ id: '1', title: 'One', status: 'pending' }],
    currentIndex: 0,
    startedAt: 1,
    updatedAt: 1,
    autoDownload: false,
    exportFormat: 'txt',
  };
}
beforeEach(() => {
  store = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => structuredClone({ [key]: store[key] }),
        set: vi.fn(async (data: Record<string, unknown>) => {
          Object.assign(store, structuredClone(data));
        }),
      },
    },
    tabs: { get: vi.fn(async () => tab) },
  });
});
afterEach(() => vi.unstubAllGlobals());
describe('collection ownership', () => {
  it('rejects simultaneous starts in different tabs', async () => {
    const results = await Promise.allSettled([
      handleBatchRequest('WRITE_BATCH_STATE', state(), tab),
      handleBatchRequest('WRITE_BATCH_STATE', { ...state(), runId: 'two' }, { ...tab, id: 2 }),
    ]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(await handleBatchRequest('READ_BATCH_STATE', null, { ...tab, id: 2 })).toBeNull();
  });
  it('rejects stale progress after cancellation', async () => {
    const current = (await handleBatchRequest('WRITE_BATCH_STATE', state(), tab))!;
    await handleBatchRequest('WRITE_BATCH_STATE', { ...current, isActive: false }, tab);
    await expect(handleBatchRequest('WRITE_BATCH_STATE', current, tab)).rejects.toThrow('changed');
    expect((store[BATCH_STORAGE_KEY] as BatchState).isActive).toBe(false);
  });
  it('retries failed items while preserving completed and skipped results', async () => {
    await handleBatchRequest(
      'WRITE_BATCH_STATE',
      {
        ...state(),
        isActive: false,
        items: [
          { id: '1', title: 'One', status: 'completed' },
          { id: '2', title: 'Two', status: 'failed' },
          { id: '3', title: 'Three', status: 'skipped' },
        ],
      },
      tab
    );
    const next = await handleBatchRequest('RETRY_BATCH', null, tab);
    expect(next?.currentIndex).toBe(1);
    expect(next?.items.map(item => item.status)).toEqual(['completed', 'pending', 'skipped']);
  });
  it('refuses to resume progress in a different course', async () => {
    await handleBatchRequest('WRITE_BATCH_STATE', { ...state(), isActive: false }, tab);
    await expect(
      handleBatchRequest('RESUME_BATCH', null, {
        ...tab,
        url: 'https://www.udemy.com/course/other',
      })
    ).rejects.toThrow('original course');
  });
  it('reports a refused storage write instead of claiming progress was saved', async () => {
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('Disk full'));
    await expect(handleBatchRequest('WRITE_BATCH_STATE', state(), tab)).rejects.toThrow(
      'Disk full'
    );
    expect(store[BATCH_STORAGE_KEY]).toBeUndefined();
  });
});

it('offers recovery when the owner tab is gone', async () => {
  const { getBatchState } = await import('./batch-service');
  await handleBatchRequest('WRITE_BATCH_STATE', state(), tab);
  vi.mocked(chrome.tabs.get).mockRejectedValueOnce(new Error('No such tab'));
  expect(await getBatchState()).toMatchObject({ isPaused: true });
});

it('does not auto-resume in an unrelated page that reused the same tab', async () => {
  await handleBatchRequest('WRITE_BATCH_STATE', state(), tab);
  expect(
    await handleBatchRequest('READ_BATCH_STATE', null, {
      ...tab,
      url: 'https://www.udemy.com/course/other',
    })
  ).toBeNull();
});
