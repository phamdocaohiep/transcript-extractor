// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryView } from './LibraryView';

const { remove, migrate, records, groups } = vi.hoisted(() => ({
  remove: vi.fn(),
  migrate: vi.fn().mockResolvedValue({ ran: false }),
  records: [{ id: 'first', courseId: 'group', title: 'First', wordCount: 3, collectedAt: 1 }],
  groups: [
    { id: 'group', title: 'Saved collection', platform: 'coursera', createdAt: 1, updatedAt: 1 },
  ],
}));

vi.mock('../../lib/library-db', () => ({
  deleteLecture: remove,
  migrateIntoLibrary: migrate,
  listCourses: vi.fn(async () => groups),
  listAllLectures: vi.fn(async () => records),
  getTranscript: vi.fn(),
  listHighlights: vi.fn(),
  listNotes: vi.fn(),
  listScreenshots: vi.fn(),
}));

let host: HTMLDivElement;
let root: Root;
let changed: ReturnType<typeof vi.fn<() => void>>;

beforeEach(async () => {
  vi.clearAllMocks();
  remove.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  changed = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <LibraryView
        totals={{ courses: 1, lectures: 1, words: 3 }}
        onOpenLecture={vi.fn()}
        onChanged={changed}
      />
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function selectButton(mode: string): Promise<HTMLButtonElement> {
  if (mode === 'row')
    return host.querySelector<HTMLButtonElement>('button[aria-label="Delete First"]')!;
  await act(async () => (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  return Array.from(host.querySelectorAll('button')).find(
    button => button.textContent?.trim() === 'Delete'
  )!;
}

describe('library deletion buttons', () => {
  it('uses the one-time migration when the library opens', () => {
    expect(migrate).toHaveBeenCalledWith();
  });

  it.each(['row', 'selection'])(
    '%s button removes a lecture only after deletion succeeds',
    async mode => {
      const button = await selectButton(mode);
      await act(async () => button.click());
      expect(remove).toHaveBeenCalledWith('first');
      expect(host.textContent).not.toContain('First');
      expect(changed).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['row', 'selection'])(
    '%s button displays persistence failures and keeps the lecture',
    async mode => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      remove.mockRejectedValueOnce(new Error('Storage unavailable'));
      const button = await selectButton(mode);
      await act(async () => button.click());
      expect(host.querySelector('[role="alert"]')?.textContent).toBe('Storage unavailable');
      expect(host.textContent).toContain('First');
    }
  );

  it('does not delete when confirmation is cancelled', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const button = await selectButton('row');
    await act(async () => button.click());
    expect(remove).not.toHaveBeenCalled();
    expect(host.textContent).toContain('First');
  });
});
