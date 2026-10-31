import { BATCH_STORAGE_KEY, getBatchState, type BatchState } from './batch-service';
import { groupKey } from './identity';

/** Serializes ownership changes and writes in the worker, across all tabs. */
let tail: Promise<unknown> = Promise.resolve();
export function handleBatchRequest(
  type: string,
  data: BatchState | null,
  tab: chrome.tabs.Tab | undefined
): Promise<BatchState | null> {
  const task = tail.then(async () => {
    if (tab?.id === undefined) throw new Error('Collection changes must come from a video tab.');
    const current = await getBatchState();
    if (type === 'READ_BATCH_STATE')
      return current?.ownerTabId === tab.id && groupKey(current.courseUrl) === groupKey(tab.url)
        ? current
        : null;
    let next = data;
    if (type === 'RESUME_BATCH' || type === 'RETRY_BATCH') {
      if (!current || groupKey(current.courseUrl) !== groupKey(tab.url)) {
        throw new Error('Open a video in the original course or playlist to resume.');
      }
      if (current.isActive && current.ownerTabId !== tab.id && current.ownerTabId !== undefined) {
        const owner = await chrome.tabs.get(current.ownerTabId).catch(() => null);
        if (owner && groupKey(owner.url) === groupKey(current.courseUrl)) {
          throw new Error('Stop collection in its original tab before resuming here.');
        }
      }
      const items = current.items.map(item => ({
        ...item,
        status:
          item.status === 'extracting' || (type === 'RETRY_BATCH' && item.status === 'failed')
            ? ('pending' as const)
            : item.status,
      }));
      const currentIndex = items.findIndex(item => item.status === 'pending');
      if (currentIndex < 0) throw new Error('There are no pending items to collect.');
      next = {
        ...current,
        items,
        currentIndex,
        isActive: true,
        isPaused: false,
        runId: crypto.randomUUID(),
        error: undefined,
      };
    } else {
      if (!next || !Array.isArray(next.items) || !next.runId)
        throw new Error('Invalid collection state.');
      if (current?.runId === next.runId) {
        if (current.ownerTabId !== tab.id || current.revision !== next.revision) {
          throw new Error('Collection progress changed. Reopen the popup to refresh it.');
        }
      } else if (current?.isActive) {
        throw new Error('A collection is already running. Stop it before starting another.');
      }
    }
    if (!next) throw new Error('No collection to save.');
    next = {
      ...next,
      ownerTabId: tab.id,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: Date.now(),
    };
    await chrome.storage.local.set({ [BATCH_STORAGE_KEY]: next });
    return next;
  });
  tail = task.catch(() => undefined);
  return task;
}
