import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createBackup, parseBackup, restoreBackup, type Backup } from './backup';
import {
  getLecture,
  getTranscript,
  readSnapshot,
  restoreSnapshot,
  saveLecture,
} from './library-db';

const url = 'https://www.udemy.com/course/test/learn/lecture/1';
function fixture(): Backup {
  const courseId = 'course:https://www.udemy.com/course/test';
  return {
    format: 'transcript-extractor-backup',
    version: 1,
    createdAt: '2026-10-16T00:00:00Z',
    records: {
      courses: [{ id: courseId, title: 'Test', platform: 'udemy', createdAt: 1, updatedAt: 1 }],
      lectures: [
        { id: url, courseId, title: 'Entry', url, collectedAt: 1, wordCount: 2, completedAt: 2 },
      ],
      transcripts: [{ lectureId: url, courseId, text: '[00:01] Saved text', savedAt: 1 }],
      notes: [
        { id: 'n', lectureId: url, courseId, body: 'My thought', createdAt: 1, updatedAt: 1 },
      ],
      highlights: [
        { id: 'h', lectureId: url, courseId, text: 'Saved', note: 'Important', createdAt: 1 },
      ],
      screenshots: [
        {
          lectureId: url,
          courseId,
          seconds: 1,
          dataUrl: 'data:image/png;base64,AA==',
          capturedAt: 1,
          readout: 'Code',
        },
      ],
    },
  };
}
beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('backup validation and restore', () => {
  it('round trips every record and screenshot asset, including annotation metadata', async () => {
    const original = fixture();
    await restoreBackup(original);
    const backup = await createBackup();
    expect(backup.records).toEqual(original.records);
    vi.stubGlobal('indexedDB', new IDBFactory());
    await restoreBackup(parseBackup(JSON.stringify(backup)));
    expect((await createBackup()).records).toEqual(original.records);
  });
  it('keeps existing values and is idempotent', async () => {
    await saveLecture({
      id: url,
      url,
      title: 'Current title',
      transcript: 'Current text',
      collectedAt: 3,
    });
    await restoreBackup(fixture());
    await restoreBackup(fixture());
    expect((await getLecture(url))?.title).toBe('Current title');
    expect((await getTranscript(url))?.text).toBe('Current text');
    expect((await readSnapshot()).notes).toHaveLength(1);
  });
  it.each(['{', '{}', '{"format":"transcript-extractor-backup","version":2}'])(
    'rejects unsupported or broken files: %s',
    text => {
      expect(() => parseBackup(text)).toThrow();
    }
  );
  it('rejects invalid relationships, duplicate keys, unsafe URLs and image types', () => {
    const mutations: ((backup: Backup) => void)[] = [
      b => {
        b.records.notes[0].lectureId = 'missing';
      },
      b => {
        b.records.lectures.push(b.records.lectures[0]);
      },
      b => {
        b.records.lectures[0].url = 'javascript:alert(1)';
      },
      b => {
        b.records.screenshots[0].dataUrl = 'data:image/svg+xml;base64,AA==';
      },
      b => {
        b.records.notes[0].seconds = -1;
      },
    ];
    for (const mutate of mutations) {
      const backup = fixture();
      mutate(backup);
      expect(() => parseBackup(JSON.stringify(backup))).toThrow();
    }
  });
  it('rolls back all stores if a write transaction aborts', async () => {
    await readSnapshot();
    const original = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key
    ) {
      const request = original.call(this, value, key);
      if (this.name === 'notes')
        request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(restoreSnapshot(fixture().records)).rejects.toThrow();
    expect((await readSnapshot()).lectures).toEqual([]);
  });
});
