import { clearFiles, loadFiles, hasDirectoryAccess } from './preferences';
import { completionKey } from './download';
import { lectureId } from './collection';
import { selectionKey, type DownloadItem, type Preferences } from './download-types';

/** Chrome opens the OS file manager; no folder picker or native application is needed. */
export async function revealSaved(
  url: string,
  choice: Pick<Preferences, 'format' | 'maxHeight'> = {}
): Promise<{ exact: boolean }> {
  const files = (await loadFiles(completionKey(url))).filter(file => file.downloadId !== undefined);
  const videos = [...files].reverse().filter(file => /\.(mp4|webm)$/i.test(file.name));
  const file =
    videos.find(value => value.selection === selectionKey(choice)) || videos[0] || files.at(-1);
  if (!file) {
    chrome.downloads.showDefaultFolder();
    return { exact: false };
  }
  const entry = (await chrome.downloads.search({ id: file.downloadId! }))[0];
  if (!entry || entry.exists === false)
    throw new Error('This file is no longer available in Chrome Downloads.');
  chrome.downloads.show(file.downloadId!);
  return { exact: true };
}

/** Delete only exact files recorded by the extension, never a whole folder. */
export async function deleteSaved(url: string): Promise<{ filesRecorded: boolean }> {
  const key = completionKey(url);
  const files = await loadFiles(key);
  for (const file of files) {
    if (!file.name || /[/\\]|^\.{1,2}$/.test(file.name))
      throw new Error('The saved file record is invalid. No folder will be deleted.');
    if (file.downloadId !== undefined) {
      if (!Number.isSafeInteger(file.downloadId) || file.downloadId < 0)
        throw new Error('Invalid saved download identifier.');
    } else if (!file.directory || !(await hasDirectoryAccess(file.directory, true)))
      throw new Error('Folder access was not granted. The download has not been reset.');
  }
  for (const file of files) {
    try {
      if (file.downloadId !== undefined) {
        try {
          await chrome.downloads.removeFile(file.downloadId);
        } catch (err) {
          const item = (await chrome.downloads.search({ id: file.downloadId }))[0];
          if (!item || item.exists !== false) throw err;
        }
      } else await file.directory!.removeEntry(file.name);
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
