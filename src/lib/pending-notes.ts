/**
 * Notes written on the lecture page, waiting to reach the library.
 *
 * A note taken while watching cannot be saved where it belongs at the moment it
 * is written. The library is IndexedDB on the extension's own origin, and a
 * content script's `indexedDB` is the *site's* — writing there would put a note
 * about a lecture into Udemy's storage, where nothing would ever read it. Notes
 * use a durable queue so worker restarts and page closure cannot discard them.
 *
 * So notes go into `chrome.storage.local`, which content scripts and extension
 * pages genuinely share, and the dashboard drains the queue into the library
 * when it opens. That is the same shape as the existing migration, and it means
 * a note survives closing the tab, the browser, or the machine.
 */

/** Where the queue lives. Nothing else in the extension uses this key. */
export const PENDING_NOTES_KEY = 'pending-notes';

export interface PendingNote {
  id: string;
  /** `lectureId(url, url)` — the identity the library files lectures under. */
  lectureId: string;
  url: string;
  /** What the page called the lecture, so a note can name its home. */
  lectureTitle: string;
  /** Where in the video the reader was. Absent if the player had no time. */
  seconds?: number;
  body: string;
  createdAt: number;
}

/**
 * Keep only what is actually a note.
 *
 * The queue is read back from storage that other versions of this extension
 * have written and future ones will, so a malformed entry is a real
 * possibility. One bad record must not take the rest of someone's notes with
 * it, which is what a single `JSON.parse`-and-trust would do.
 */
export function validPendingNotes(raw: unknown): PendingNote[] {
  if (!Array.isArray(raw)) return [];

  return raw.filter((entry): entry is PendingNote => {
    if (!entry || typeof entry !== 'object') return false;
    const note = entry as Partial<PendingNote>;
    return (
      typeof note.id === 'string' && note.id.length > 0 &&
      typeof note.url === 'string' && typeof note.lectureTitle === 'string' &&
      typeof note.createdAt === 'number' && Number.isFinite(note.createdAt) &&
      typeof note.lectureId === 'string' &&
      note.lectureId.length > 0 &&
      typeof note.body === 'string' &&
      note.body.trim().length > 0 &&
      (note.seconds === undefined || (typeof note.seconds === 'number' && Number.isFinite(note.seconds) && note.seconds >= 0))
    );
  });
}

function storage(): chrome.storage.LocalStorageArea | null {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
    return chrome.storage.local;
  } catch {
    return null;
  }
}

/** Each note has its own key so simultaneous tabs cannot overwrite a shared array. */
const PREFIX = 'pending-note:';

export async function queueNote(note: PendingNote): Promise<boolean> {
  const area = storage();
  if (!area || validPendingNotes([note]).length !== 1) return false;
  try {
    await area.set({ [`${PREFIX}${note.id}`]: note });
    return true;
  } catch {
    return false;
  }
}

/** Reading never acknowledges delivery. A failed database write must remain retryable. */
export async function readPendingNotes(): Promise<PendingNote[]> {
  const area = storage();
  if (!area) return [];
  const held = await area.get(null);
  const notes = validPendingNotes(held[PENDING_NOTES_KEY]);
  notes.push(...validPendingNotes(Object.entries(held)
    .filter(([key]) => key.startsWith(PREFIX)).map(([, value]) => value)));
  return [...new Map(notes.map(note => [note.id, note])).values()];
}

/** Called only after the corresponding IndexedDB transaction commits. */
export async function acknowledgeNote(id: string): Promise<void> {
  const area = storage();
  if (!area) throw new Error('Note storage is unavailable.');
  await area.remove(`${PREFIX}${id}`);
  const held = await area.get(PENDING_NOTES_KEY);
  const legacy = validPendingNotes(held[PENDING_NOTES_KEY]);
  if (legacy.some(note => note.id === id)) {
    await area.set({ [PENDING_NOTES_KEY]: legacy.filter(note => note.id !== id) });
  }
}
