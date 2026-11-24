import { outputNameKey, validOutputName } from './download-names';

/** Stage large output on browser-owned disk, without a user-selected directory. */
export async function createDestination() {
  const root = await navigator.storage.getDirectory();
  const name = `download-output-${crypto.randomUUID()}`;
  const directory = await root.getDirectoryHandle(name, { create: true });
  return { directory, dispose: () => root.removeEntry(name, { recursive: true }) };
}

export async function publishFile(
  directory: FileSystemDirectoryHandle,
  filename: string,
  signal: AbortSignal
): Promise<number> {
  signal.throwIfAborted();
  if (!validOutputName(filename)) throw new Error('Invalid output filename.');
  const file = await (await directory.getFileHandle(filename)).getFile();
  const url = URL.createObjectURL(file);
  try {
    await chrome.storage.session.set({ [outputNameKey(url)]: filename });
    signal.throwIfAborted();
    const id = await chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | DOMException) => {
        if (settled) return;
        settled = true;
        chrome.downloads.onChanged.removeListener(changed);
        signal.removeEventListener('abort', cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => {
        void chrome.downloads.cancel(id).catch(() => undefined);
        finish(new DOMException('Download cancelled.', 'AbortError'));
      };
      const changed = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id !== id) return;
        if (delta.state?.current === 'complete') finish();
        else if (delta.state?.current === 'interrupted')
          finish(
            new Error(`Chrome download interrupted: ${delta.error?.current || 'unknown error'}.`)
          );
      };
      chrome.downloads.onChanged.addListener(changed);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) {
        cancel();
        return;
      }
      // Covers completion before the listener was attached.
      void chrome.downloads
        .search({ id })
        .then(results => {
          if (results[0]?.state === 'complete') finish();
          else if (!results.length || results[0].state === 'interrupted')
            finish(new Error('Chrome could not complete this download.'));
        })
        .catch(error => finish(error));
    }).catch(async error => {
      if (!signal.aborted) await chrome.downloads.cancel(id).catch(() => undefined);
      throw error;
    });
    return id;
  } finally {
    await chrome.storage.session.remove(outputNameKey(url)).catch(() => undefined);
    URL.revokeObjectURL(url);
  }
}
