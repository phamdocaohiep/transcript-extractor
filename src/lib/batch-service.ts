import { groupKey } from './identity';
import { isPageContext } from './context';
/**
 * Batch extraction service for walking and extracting entire courses.
 *
 * State is persisted in `chrome.storage.local` under `course_batch_state` so
 * that batch extraction continues reliably across popup open/close events,
 * SPA navigations, and temporary tab inactivity.
 */

import type { ExportFormat } from './extension-service';

export interface BatchItem {
  id: string;
  title: string;
  url?: string;
  duration?: string;
  status: 'pending' | 'extracting' | 'completed' | 'skipped' | 'failed';
  error?: string;
  wordCount?: number;
}

export interface BatchState {
  runId?: string;
  ownerTabId?: number;
  revision?: number;
  error?: string;
  isActive: boolean;
  isPaused: boolean;
  courseTitle: string;
  courseUrl: string;
  items: BatchItem[];
  currentIndex: number;
  startedAt: number;
  updatedAt: number;
  autoDownload: boolean;
  exportFormat: ExportFormat;
}

export const BATCH_STORAGE_KEY = 'course_batch_state';

/** Only display progress belonging to the course currently open in the popup. */
export function batchForCourse(state: BatchState | null, url: string | null | undefined): BatchState | null {
  return state && url && groupKey(state.courseUrl) === groupKey(url) ? state : null;
}


/**
 * Load the active batch state from storage.
 */
export async function getBatchState(): Promise<BatchState | null> {
  if (isPageContext()) {
    const response = await chrome.runtime.sendMessage({ type: 'READ_BATCH_STATE' });
    if (!response?.success) throw new Error(response?.error || 'Could not read collection progress.');
    return response.data;
  }
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
  const result = await chrome.storage.local.get(BATCH_STORAGE_KEY);
  const state = (result[BATCH_STORAGE_KEY] as BatchState | undefined) ?? null;
  if (state?.isActive && chrome.tabs?.get) {
    const owner = state.ownerTabId === undefined ? null : await chrome.tabs.get(state.ownerTabId).catch(() => null);
    if (!owner || groupKey(owner.url) !== groupKey(state.courseUrl)) {
      return { ...state, isPaused: true, error: 'The original video tab is closed or has left this course. Open the same course or playlist and resume.' };
    }
  }
  return state;
}

export async function setBatchState(state: BatchState | null): Promise<void> {
  if (isPageContext()) {
    const response = await chrome.runtime.sendMessage({ type: 'WRITE_BATCH_STATE', data: state });
    if (!response?.success) throw new Error(response?.error || 'The extension background did not confirm the save. Reload Transcript Extractor in chrome://extensions, then refresh this course page and try again.');
    if (state && response.data) Object.assign(state, response.data);
    return;
  }
  if (typeof chrome === 'undefined' || !chrome.storage?.local) throw new Error('Storage unavailable.');
  if (state === null) await chrome.storage.local.remove(BATCH_STORAGE_KEY);
  else await chrome.storage.local.set({ [BATCH_STORAGE_KEY]: state });
}

/**
 * Calculate completion percentage and summary numbers.
 */
export function getBatchProgress(state: BatchState | null): {
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  pending: number;
  percent: number;
  completedPercent: number;
} {
  if (!state || !state.items || state.items.length === 0) {
    return { total: 0, completed: 0, skipped: 0, failed: 0, pending: 0, percent: 0, completedPercent: 0 };
  }

  const total = state.items.length;
  let completed = 0;
  let skipped = 0;
  let failed = 0;
  let pending = 0;

  for (const item of state.items) {
    if (item.status === 'completed') completed++;
    else if (item.status === 'skipped') skipped++;
    else if (item.status === 'failed') failed++;
    else pending++;
  }

  const processed = completed + skipped + failed;
  const percent = total > 0 ? Math.round((processed / total) * 100) : 0;
  const completedPercent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return { total, completed, skipped, failed, pending, percent, completedPercent };
}
