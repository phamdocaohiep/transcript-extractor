import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import {
  deleteLecture,
  deleteTranscript,
  getLecture,
  getTranscript,
  importLegacyFrames,
  libraryTotals,
  listAllLectures,
  listHighlights,
  listNotes,
  listScreenshots,
  migrateIntoLibrary,
  saveHighlight,
  saveNote,
  saveScreenshot,
} from './library-db';
import { loadCourseCollection, removeCourseLecture } from './collection-store';
import { collectionKey } from './collection';
import { courseIdFromUrl } from './library-schema';

const url = 'https://www.coursera.org/learn/example/lecture/first';
const entry = { id: url, url, title: 'First', transcript: '[00:01] Saved text', collectedAt: 1 };
const other = { ...entry, id: `${url}-other`, title: 'Other' };
let stored: Record<string, unknown>;
let set: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  stored = {
    [collectionKey(url)]: [entry, other],
    preference: 'keep',
  };
  set = vi.fn(async (changes: Record<string, unknown>) => {
    Object.assign(stored, structuredClone(changes));
  });
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string | null) =>
          structuredClone(key === null ? stored : { [key]: stored[key] })
        ),
        set,
      },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function seedAttachments() {
  const courseId = courseIdFromUrl(url);
  await saveNote({
    id: 'note',
    lectureId: entry.id,
    courseId,
    body: 'Keep note',
    createdAt: 1,
    updatedAt: 1,
  });
  await saveHighlight({
    id: 'highlight',
    lectureId: entry.id,
    courseId,
    text: 'Marked',
    createdAt: 1,
  });
  await saveScreenshot({
    lectureId: entry.id,
    courseId,
    seconds: 1,
    dataUrl: 'data:image/png;base64,AA==',
    capturedAt: 1,
  });
}

describe('persistent deletion', () => {
  it('does not restore a deleted lecture after migration or collection reload', async () => {
    await migrateIntoLibrary();
    stored['collection:duplicate'] = [entry];
    await seedAttachments();
    await deleteLecture(entry.id);
    await migrateIntoLibrary(true);
    expect((await listAllLectures()).map(item => item.id)).toEqual([other.id]);
    expect(await getTranscript(entry.id)).toBeUndefined();
    expect(await listNotes(entry.id)).toEqual([]);
    expect(await listHighlights(entry.id)).toEqual([]);
    expect(await listScreenshots(entry.id)).toEqual([]);
    expect((await loadCourseCollection(url)).map(item => item.id)).toEqual([other.id]);
    expect(stored['collection:duplicate']).toEqual([]);
    expect(stored.preference).toBe('keep');
  });

  it('does not recover the last deleted lecture from legacy storage', async () => {
    stored[collectionKey(url)] = [entry];
    await migrateIntoLibrary();
    await deleteLecture(entry.id);
    expect(await loadCourseCollection(url)).toEqual([]);
    expect(await libraryTotals()).toEqual({ courses: 0, lectures: 0, words: 0 });
  });

  it('keeps transcript-only deletion after reimport while preserving metadata and attachments', async () => {
    await migrateIntoLibrary();
    await seedAttachments();
    stored['collection:duplicate'] = [entry];
    await deleteTranscript(entry.id);
    expect(await getTranscript(entry.id)).toBeUndefined();
    expect(await getLecture(entry.id)).toMatchObject({ title: 'First', wordCount: 0 });
    expect((await loadCourseCollection(url)).find(item => item.id === entry.id)?.transcript).toBe(
      ''
    );
    await migrateIntoLibrary(true);
    expect((await getTranscript(entry.id))?.text ?? '').toBe('');
    expect(await listNotes(entry.id)).toHaveLength(1);
    expect(await listHighlights(entry.id)).toHaveLength(1);
    expect(await listScreenshots(entry.id)).toHaveLength(1);
    expect((stored['collection:duplicate'] as (typeof entry)[])[0].transcript).toBe('');
  });

  it('honors the one-time migration flag instead of overwriting current data on opening', async () => {
    await migrateIntoLibrary();
    stored[collectionKey(url)] = [{ ...entry, transcript: 'Old backup' }];
    expect((await migrateIntoLibrary()).ran).toBe(false);
    expect((await getTranscript(entry.id))?.text).toBe(entry.transcript);
  });

  it('propagates storage failure without removing the visible database record', async () => {
    await migrateIntoLibrary();
    set.mockRejectedValueOnce(new Error('Storage failed'));
    await expect(deleteLecture(entry.id)).rejects.toThrow('Storage failed');
    expect(await getLecture(entry.id)).toBeDefined();
    expect((await getTranscript(entry.id))?.text).toBe(entry.transcript);
  });

  it('does not hide deletion failures in the popup adapter', async () => {
    await migrateIntoLibrary();
    set.mockRejectedValueOnce(new Error('Storage failed'));
    await expect(removeCourseLecture(entry.id, [entry], url)).rejects.toThrow('Storage failed');
  });

  it('rejects a transaction aborted after its delete request succeeds', async () => {
    await migrateIntoLibrary();
    const original = IDBObjectStore.prototype.delete;
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (
      this: IDBObjectStore,
      key
    ) {
      const request = original.call(this, key);
      request.addEventListener('success', () => this.transaction.abort(), { once: true });
      return request;
    });
    await expect(deleteTranscript(entry.id)).rejects.toThrow('transaction aborted');
    expect((await getTranscript(entry.id))?.text).toBe(entry.transcript);
  });

  it('removes old frame copies so importing screenshots cannot restore a deleted lecture', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('transcript-extractor-frames');
      request.onupgradeneeded = () =>
        request.result.createObjectStore('frames', { keyPath: ['lectureId', 'seconds'] });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('frames', 'readwrite');
        tx.objectStore('frames').put({
          lectureId: entry.id,
          seconds: 1,
          dataUrl: 'data:image/png;base64,AA==',
          capturedAt: 1,
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
    await migrateIntoLibrary();
    await deleteLecture(entry.id);
    expect(await importLegacyFrames()).toBe(0);
    expect(await listScreenshots(entry.id)).toEqual([]);
  });
});

describe('queued note delivery', () => {
  it('retains notes after an aborted database write and imports them once on retry', async () => {
    const { queueNote, readPendingNotes } = await import('./pending-notes');
    const { importPendingNotes } = await import('./library-db');
    chrome.storage.local.remove = vi.fn(async key => {
      for (const name of Array.isArray(key) ? key : [key]) delete stored[name];
    });
    await queueNote({ id: 'queued', lectureId: entry.id, url, lectureTitle: 'First', body: 'Keep me', createdAt: 1 });
    const original = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = original.call(this, value, key);
      if (this.name === 'notes') request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(importPendingNotes()).rejects.toThrow();
    expect(await readPendingNotes()).toHaveLength(1);
    spy.mockRestore();
    await importPendingNotes();
    await importPendingNotes();
    expect(await readPendingNotes()).toEqual([]);
    expect(await listNotes(entry.id)).toHaveLength(1);
  });
});

describe('group repair', () => {
  it('moves every attachment with its entry, without overwriting completion metadata', async () => {
    const { normalizeGroups, readSnapshot, restoreSnapshot } = await import('./library-db');
    await migrateIntoLibrary();
    await seedAttachments();
    const snapshot = await readSnapshot();
    const old = 'course:https://www.coursera.org/learn/example/lecture/first';
    snapshot.courses = [{ ...snapshot.courses[0], id: old }];
    for (const name of ['lectures', 'transcripts', 'notes', 'highlights', 'screenshots'] as const) {
      snapshot[name].forEach(record => { record.courseId = old; });
    }
    snapshot.lectures[0].completedAt = 42;
    vi.stubGlobal('indexedDB', new IDBFactory());
    await restoreSnapshot(snapshot);
    await normalizeGroups();
    const after = await readSnapshot();
    expect(after.courses).toHaveLength(1);
    expect(after.lectures[0].completedAt).toBe(42);
    for (const name of ['lectures', 'transcripts', 'notes', 'highlights', 'screenshots'] as const) {
      expect(after[name].every(record => record.courseId === courseIdFromUrl(url))).toBe(true);
    }
    await normalizeGroups();
    expect(await readSnapshot()).toEqual(after);
  });
});

it('moves existing annotations atomically when a video is collected in another playlist', async () => {
  const { saveLecture, readSnapshot } = await import('./library-db');
  const url = 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=one';
  const id = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
  const courseId = courseIdFromUrl(url);
  await saveLecture({ id, url, title: 'Video', transcript: 'Original', collectedAt: 1 });
  await saveNote({ id: 'moved', lectureId: id, courseId, body: 'Keep', createdAt: 1, updatedAt: 1 });
  await saveLecture({ id, url: url.replace('list=one', 'list=two'), title: 'Video', transcript: 'Updated', collectedAt: 2 });
  const snapshot = await readSnapshot();
  const target = courseIdFromUrl(url.replace('list=one', 'list=two'));
  expect(snapshot.courses.map(record => record.id)).toEqual([target]);
  expect(snapshot.notes[0].courseId).toBe(target);
  expect(snapshot.transcripts[0].courseId).toBe(target);
});
