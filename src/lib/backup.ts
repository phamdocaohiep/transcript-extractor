import {
  importPendingNotes,
  migrateIntoLibrary,
  normalizeGroups,
  readSnapshot,
  restoreSnapshot,
  type LibrarySnapshot,
} from './library-db';

export interface Backup {
  format: 'transcript-extractor-backup';
  version: 1;
  createdAt: string;
  records: LibrarySnapshot;
}

export const MAX_BACKUP_BYTES = 250 * 1024 * 1024;

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const optional = (value: unknown, check: (value: unknown) => boolean) =>
  value === undefined || check(value);
const url = (value: unknown) => {
  if (!text(value)) return false;
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

/** Validate the entire file before opening a write transaction. Never trust imported JSON. */
export function parseBackup(input: string): Backup {
  if (new Blob([input]).size > MAX_BACKUP_BYTES)
    throw new Error('Backup exceeds the 250 MB limit.');
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new Error('This is not a valid JSON backup.');
  }
  if (
    !object(raw) ||
    raw.format !== 'transcript-extractor-backup' ||
    raw.version !== 1 ||
    !text(raw.createdAt) ||
    !Number.isFinite(Date.parse(raw.createdAt)) ||
    !object(raw.records)
  ) {
    throw new Error('Unsupported backup format or version.');
  }
  const fields = {
    courses: ['id', 'title', 'instructor', 'platform', 'url', 'createdAt', 'updatedAt'],
    lectures: [
      'id',
      'courseId',
      'title',
      'url',
      'durationSeconds',
      'order',
      'collectedAt',
      'wordCount',
      'completedAt',
    ],
    transcripts: ['lectureId', 'courseId', 'text', 'savedAt', 'timing'],
    notes: ['id', 'lectureId', 'courseId', 'seconds', 'body', 'createdAt', 'updatedAt'],
    highlights: ['id', 'lectureId', 'courseId', 'seconds', 'text', 'note', 'createdAt'],
    screenshots: ['lectureId', 'courseId', 'seconds', 'dataUrl', 'capturedAt', 'readout'],
  } as const;
  const records = {} as LibrarySnapshot;
  for (const name of Object.keys(fields) as (keyof LibrarySnapshot)[]) {
    const values = raw.records[name];
    if (!Array.isArray(values) || values.length > 100_000)
      throw new Error(`Invalid ${name} collection.`);
    const seen = new Set<string>();
    const checked = values.map((value: unknown) => {
      if (!object(value)) throw new Error(`Invalid record in ${name}.`);
      const record = Object.fromEntries(
        fields[name].filter(key => value[key] !== undefined).map(key => [key, value[key]])
      );
      const id =
        name === 'screenshots'
          ? JSON.stringify([record.lectureId, record.seconds])
          : name === 'transcripts'
            ? record.lectureId
            : record.id;
      const validId = text(id) && id.length > 0 && !seen.has(id);
      const related = name === 'courses' || (text(record.courseId) && record.courseId.length > 0);
      const anchored =
        !['notes', 'highlights', 'screenshots', 'transcripts'].includes(name) ||
        (text(record.lectureId) && record.lectureId.length > 0);
      let valid = false;
      switch (name) {
        case 'courses':
          valid =
            text(record.title) &&
            optional(record.instructor, text) &&
            ['udemy', 'coursera', 'youtube', 'generic', 'unknown'].includes(
              String(record.platform)
            ) &&
            optional(record.url, url) &&
            number(record.createdAt) &&
            number(record.updatedAt);
          break;
        case 'lectures':
          valid =
            text(record.title) &&
            optional(record.url, url) &&
            number(record.collectedAt) &&
            number(record.wordCount) &&
            optional(record.durationSeconds, number) &&
            optional(record.order, number) &&
            optional(record.completedAt, number);
          break;
        case 'transcripts':
          valid =
            text(record.text) &&
            number(record.savedAt) &&
            optional(record.timing, value =>
              ['source', 'estimated', 'unknown'].includes(String(value))
            );
          break;
        case 'notes':
          valid =
            text(record.body) &&
            number(record.createdAt) &&
            number(record.updatedAt) &&
            optional(record.seconds, number);
          break;
        case 'highlights':
          valid =
            text(record.text) &&
            optional(record.note, text) &&
            number(record.createdAt) &&
            optional(record.seconds, number);
          break;
        case 'screenshots':
          valid =
            number(record.seconds) &&
            number(record.capturedAt) &&
            optional(record.readout, text) &&
            text(record.dataUrl) &&
            /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(record.dataUrl);
          break;
      }
      if (!validId || !related || !anchored || !valid)
        throw new Error(`Invalid or duplicate record in ${name}.`);
      seen.add(id as string);
      return record;
    });
    (records[name] as unknown[]) = checked;
  }
  const courses = new Set(records.courses.map(record => record.id));
  const lectures = new Map(records.lectures.map(record => [record.id, record.courseId]));
  for (const record of records.lectures) {
    if (!courses.has(record.courseId))
      throw new Error('A transcript entry references a missing group.');
  }
  for (const name of ['transcripts', 'notes', 'highlights', 'screenshots'] as const) {
    for (const record of records[name]) {
      if (lectures.get(record.lectureId) !== record.courseId) {
        throw new Error(`An item in ${name} references a missing or mismatched entry.`);
      }
    }
  }
  return { format: 'transcript-extractor-backup', version: 1, createdAt: raw.createdAt, records };
}

export async function createBackup(): Promise<Backup> {
  await migrateIntoLibrary();
  await importPendingNotes();
  const records = await readSnapshot();
  return parseBackup(
    JSON.stringify({
      format: 'transcript-extractor-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      records,
    })
  );
}

export async function restoreBackup(backup: Backup): Promise<void> {
  const validated = parseBackup(JSON.stringify(backup));
  await restoreSnapshot(validated.records);
  await normalizeGroups();
}

export function backupCounts(backup: Backup): string {
  const r = backup.records;
  return (
    `${r.lectures.length} entries, ${r.transcripts.length} transcripts, ${r.notes.length} notes, ` +
    `${r.highlights.length} highlights, ${r.screenshots.length} screenshots`
  );
}
