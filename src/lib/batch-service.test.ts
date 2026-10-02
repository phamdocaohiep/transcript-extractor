import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getBatchProgress,
  getBatchState,
  setBatchState,
  type BatchState,
  BATCH_STORAGE_KEY,
} from './batch-service';

describe('batch-service', () => {
  let fakeStorage: Record<string, unknown> = {};

  beforeEach(() => {
    fakeStorage = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: fakeStorage[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(fakeStorage, items);
          }),
          remove: vi.fn(async (key: string) => {
            delete fakeStorage[key];
          }),
        },
      },
    };
  });

  it('computes correct progress for empty or null state', () => {
    expect(getBatchProgress(null)).toEqual({
      total: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
      pending: 0,
      percent: 0,
      completedPercent: 0,
    });
  });

  it('computes correct progress for mixed status items', () => {
    const state: BatchState = {
      isActive: true,
      isPaused: false,
      courseTitle: 'Full Python Course',
      courseUrl: 'https://www.udemy.com/course/python/learn/lecture/1',
      currentIndex: 2,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      autoDownload: true,
      exportFormat: 'markdown',
      items: [
        { id: '1', title: 'Intro', status: 'completed' },
        { id: '2', title: 'Quiz 1', status: 'skipped' },
        { id: '3', title: 'Functions', status: 'extracting' },
        { id: '4', title: 'Classes', status: 'pending' },
      ],
    };

    const progress = getBatchProgress(state);
    expect(progress.total).toBe(4);
    expect(progress.completed).toBe(1);
    expect(progress.skipped).toBe(1);
    expect(progress.pending).toBe(2);
    expect(progress.percent).toBe(50);
    expect(progress.completedPercent).toBe(25);
  });

  it('persists and retrieves batch state via chrome.storage.local', async () => {
    const state: BatchState = {
      isActive: true,
      isPaused: false,
      courseTitle: 'Test Course',
      courseUrl: 'https://www.udemy.com/course/test',
      currentIndex: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      autoDownload: false,
      exportFormat: 'txt',
      items: [{ id: '1', title: 'L1', status: 'pending' }],
    };

    await setBatchState(state);
    const loaded = await getBatchState();
    expect(loaded?.courseTitle).toBe('Test Course');

    await setBatchState(null);
    const cleared = await getBatchState();
    expect(cleared).toBeNull();
  });
});
