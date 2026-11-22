import { clearFiles, loadFiles, hasDirectoryAccess } from './preferences';
import { completionKey } from './download';
import { lectureId } from './collection';
import type { DownloadItem } from './download-types';

/** Delete only exact files recorded by the extension, never a whole folder. */
export async function deleteSaved(url: string): Promise<{ filesRecorded: boolean }> {
  const key = completionKey(url);
  const files = await loadFiles(key);
  for (const file of files) {
    if (!file.name || /[/\\]|^\.{1,2}$/.test(file.name))
      throw new Error('The saved file record is invalid. No folder will be deleted.');
    if (!(await hasDirectoryAccess(file.directory, true)))
      throw new Error('Folder access was not granted. The download has not been reset.');
  }
  for (const file of files) {
    try {
      await file.directory.removeEntry(file.name);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err;
    }
  }
  const data = await chrome.storage.local.get(null);
  const id = lectureId(url, '');
  const updates: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(data)) {
    if (name === key || name.startsWith(`${key}:quality:`))
      updates[name] = { video: false, transcript: false };
    if (name.startsWith('download_queue:') && Array.isArray(value))
      updates[name] = (value as DownloadItem[]).map(item =>
        item.url && lectureId(item.url, '') === id
          ? {
              ...item,
              status: 'pending',
              saved: { video: false, transcript: false },
              error: undefined,
            }
          : item
      );
  }
  await chrome.storage.local.set(updates);
  await clearFiles(key);
  return { filesRecorded: files.length > 0 };
}
