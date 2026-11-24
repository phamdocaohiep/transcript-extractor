import type { Preferences } from './download-types';
export const DEFAULT_PREFERENCES: Preferences = { video: true, transcript: true, automatic: false };
export const PREFERENCES_KEY = 'download_preferences_v1';

export async function loadPreferences(): Promise<Preferences> {
  const data = (await chrome.storage.local.get(PREFERENCES_KEY))[PREFERENCES_KEY] as
    | Partial<Preferences>
    | undefined;
  const maxHeight = data?.maxHeight;
  return {
    video: typeof data?.video === 'boolean' ? data.video : true,
    transcript: typeof data?.transcript === 'boolean' ? data.transcript : true,
    automatic: typeof data?.automatic === 'boolean' ? data.automatic : false,
    ...(data?.audio === true ? { audio: true } : {}),
    ...(typeof data?.materials === 'boolean' ? { materials: data.materials } : {}),
    ...(data?.deleteFiles === true ? { deleteFiles: true } : {}),
    ...(data?.reload === true ? { reload: true } : {}),
    ...(data?.format === 'mp4' || data?.format === 'webm' ? { format: data.format } : {}),
    ...(typeof maxHeight === 'number' &&
    Number.isInteger(maxHeight) &&
    maxHeight > 0 &&
    maxHeight <= 8640
      ? { maxHeight }
      : {}),
  };
}

export async function savePreferences(value: Preferences): Promise<void> {
  await chrome.storage.local.set({ [PREFERENCES_KEY]: value });
}

// File system handles use structured cloning and must be stored in IndexedDB.
async function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('transcript-extractor-preferences', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('values');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export interface SavedFile {
  directory?: FileSystemDirectoryHandle;
  downloadId?: number;
  kind?: 'video' | 'audio' | 'transcript';
  name: string;
  selection?: string;
}
export async function recordFile(key: string, file: SavedFile): Promise<void> {
  const db = await openStore();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('values', 'readwrite');
      const store = tx.objectStore('values');
      const request = store.get(`files:${key}`);
      request.onsuccess = () => store.put([...(request.result || []), file], `files:${key}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function loadFiles(key: string): Promise<SavedFile[]> {
  const db = await openStore();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('values').objectStore('values').get(`files:${key}`);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
export async function clearFiles(key: string): Promise<void> {
  const db = await openStore();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('values', 'readwrite');
      tx.objectStore('values').delete(`files:${key}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function saveDirectory(
  value: FileSystemDirectoryHandle,
  key = 'directory'
): Promise<void> {
  const db = await openStore();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('values', 'readwrite');
      tx.objectStore('values').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadDirectory(key = 'directory'): Promise<FileSystemDirectoryHandle | null> {
  const db = await openStore();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('values').objectStore('values').get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function hasDirectoryAccess(
  directory: FileSystemDirectoryHandle,
  request = false,
  onRequest?: () => void
): Promise<boolean> {
  const handle = directory as FileSystemDirectoryHandle & {
    queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
    requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  };
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  if (!request) return false;
  onRequest?.();
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}
