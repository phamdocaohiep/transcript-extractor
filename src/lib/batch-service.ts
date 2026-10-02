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

/**
 * Load the active batch state from storage.
 */
export async function getBatchState(): Promise<BatchState | null> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
    const result = await chrome.storage.local.get(BATCH_STORAGE_KEY);
    return (result[BATCH_STORAGE_KEY] as BatchState | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Save updated batch state to storage.
 */
export async function setBatchState(state: BatchState | null): Promise<void> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    if (state === null) {
      await chrome.storage.local.remove(BATCH_STORAGE_KEY);
    } else {
      await chrome.storage.local.set({ [BATCH_STORAGE_KEY]: state });
    }
  } catch {
    // Storage failure should never crash the caller
  }
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
