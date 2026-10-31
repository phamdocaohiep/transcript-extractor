import { log } from '../../lib/log';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Library,
  Search as SearchIcon,
  StickyNote,
  Highlighter,
  Sun,
  Moon,
} from 'lucide-react';
import {
  deleteCourse,
  importPendingNotes,
  libraryTotals,
  listCourses,
  migrateIntoLibrary,
} from '../../lib/library-db';
import { BackupControls } from '../BackupControls';
import { BrandTile } from '../BrandTile';
import { applyTheme, resolveTheme, storeTheme, type Theme } from '../../lib/theme';
import { LibraryView } from './LibraryView';
import { LectureView } from './LectureView';
import { SearchView } from './SearchView';
import { NotesView } from './NotesView';
import { HighlightsView } from './HighlightsView';

/**
 * The library, as a full extension page.
 *
 * The popup is the wrong host for anything that takes more than an instant: it
 * is destroyed the moment it loses focus, which takes every in-flight read and
 * index with it. This page is an ordinary tab, so whole-library indexing,
 * cross-course search and reading a three-thousand-word transcript are all
 * possible here and none of them are possible there.
 *
 * Navigation is a small tagged union rather than a router. There are four
 * places to be, the page is not addressable from outside the extension, and a
 * routing library would be more machinery than the problem has.
 */
export type View =
  | { name: 'library' }
  | { name: 'lecture'; lectureId: string }
  | { name: 'search' }
  | { name: 'highlights' }
  | { name: 'notes' };

interface Totals {
  courses: number;
  lectures: number;
  words: number;
}

export const Dashboard: React.FC = () => {
  const [view, setView] = useState<View>({ name: 'library' });
  const [theme, setTheme] = useState<Theme>(() => resolveTheme());
  const [totals, setTotals] = useState<Totals | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Bytes this extension is using, as the browser reports it. */
  const [usage, setUsage] = useState<number | null>(null);

  /** Bumped after a bulk change, so the library re-reads from scratch. */
  const [libraryVersion, setLibraryVersion] = useState(0);

  const refreshTotals = useCallback(async () => {
    try {
      setTotals(await libraryTotals());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The library could not be read.');
    }
    try {
      const estimate = await navigator.storage?.estimate?.();
      setUsage(estimate?.usage ?? null);
    } catch {
      setUsage(null);
    }
  }, []);

  const clearAllHistory = async () => {
    if (
      !window.confirm(
        'Delete every course, transcript, note, highlight and screenshot in your library? This cannot be undone.',
      )
    ) {
      return;
    }
    try {
      for (const course of await listCourses()) await deleteCourse(course.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The library could not be cleared.');
    }
    await refreshTotals();
    setLibraryVersion((v) => v + 1);
    setView({ name: 'library' });
  };

  // Migrate before first read, so a user opening the dashboard for the first
  // time sees the courses they have already collected rather than an empty
  // library and a reason to close the tab.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await migrateIntoLibrary();
      } catch (cause) {
        setError('Library upgrade failed. Your existing data has been kept. Reopen the library to retry.');
        console.error('[library] migration failed', cause);
      }

      // Notes written on the lecture page have been waiting in storage for an
      // extension page to open; this is that page. Its own catch, so one bad
      // note cannot stop the library loading.
      try {
        const imported = await importPendingNotes();
        if (imported > 0) log.debug(`[library] imported ${imported} notes from the player`);
      } catch (cause) {
        setError('Some player notes could not be imported. They remain queued; reopen the library to retry.');
        console.error('[library] importing player notes failed', cause);
      }

      if (cancelled) return;
      await refreshTotals();
      if (!cancelled) setReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshTotals]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    storeTheme(next);
    setTheme(next);
  };

  const navIcon = 'h-[18px] w-[18px]';
  const navItems: { view: View; label: string; icon: React.ReactNode; count?: number }[] = [
    {
      view: { name: 'library' },
      label: 'Library',
      icon: <Library className={navIcon} strokeWidth={1.9} />,
      count: totals?.lectures,
    },
    { view: { name: 'search' }, label: 'Search', icon: <SearchIcon className={navIcon} strokeWidth={1.9} /> },
    {
      view: { name: 'highlights' },
      label: 'Highlights',
      icon: <Highlighter className={navIcon} strokeWidth={1.9} />,
    },
    { view: { name: 'notes' }, label: 'Notes', icon: <StickyNote className={navIcon} strokeWidth={1.9} /> },
  ];

  const isActive = (candidate: View) =>
    candidate.name === view.name ||
    // A lecture is reached from the library, so the library stays lit.
    (candidate.name === 'library' && view.name === 'lecture');

  return (
    <div className="te-page flex flex-wrap items-stretch gap-4 p-4">
      {/* Navigation. Four destinations, each of which does something real —
          a longer list would be mostly labels for things that are really just
          filters over the same records. */}
      <nav
        aria-label="Library sections"
        className="te-glass te-lib-side box-border flex flex-col gap-[18px] rounded-[22px] px-3 py-4"
      >
        {/* Same shape as the popup header, toggle included — two surfaces of
            one product should not hide the same control in different places. */}
        <div className="flex items-center gap-2.5 px-1">
          <BrandTile />
          <div className="flex min-w-0 flex-grow flex-col gap-px">
            <p className="truncate text-[15px] font-semibold tracking-[-0.01em]">
              Transcript Extractor
            </p>
            <p className="te-muted flex items-center gap-1.5 text-[12px]">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: 'var(--te-success)' }}
                aria-hidden="true"
              />
              Local · private
            </p>
          </div>
          <button
            type="button"
            onClick={toggleTheme}
            className="te-ghost-icon"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {theme === 'dark' ? (
              <Sun className="h-[17px] w-[17px]" strokeWidth={1.8} />
            ) : (
              <Moon className="h-[17px] w-[17px]" strokeWidth={1.8} />
            )}
          </button>
        </div>

        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {navItems.map((item) => (
            <li key={item.label}>
              <button
                type="button"
                onClick={() => setView(item.view)}
                aria-current={isActive(item.view) ? 'page' : undefined}
                className="te-nav-link"
              >
                {item.icon}
                <span className="flex-grow">{item.label}</span>
                {item.count !== undefined && (
                  <span className="te-mono text-[12px]">{item.count}</span>
                )}
              </button>
            </li>
          ))}
        </ul>

        <div
          className="mt-auto flex flex-col gap-1 rounded-[14px] p-3 text-[12px]"
          style={{ background: 'var(--te-fill)', color: 'var(--te-text-2)' }}
        >
          <span className="font-semibold" style={{ color: 'var(--te-text)' }}>
            Stored on this device
          </span>
          <span>
            {totals ? `${totals.lectures} ${totals.lectures === 1 ? 'transcript' : 'transcripts'}` : '…'}
            {usage !== null ? ` · ${formatBytes(usage)}` : ''}
          </span>
          <BackupControls onChanged={async () => {
            await refreshTotals();
            setLibraryVersion(value => value + 1);
            setView({ name: 'library' });
          }} />
          {totals && totals.lectures > 0 && (
            <button
              type="button"
              onClick={() => void clearAllHistory()}
              className="mt-1 self-start font-medium hover:underline"
              style={{ color: 'var(--te-accent-text)' }}
            >
              Clear all history…
            </button>
          )}
        </div>
      </nav>

      <main className="flex min-w-0 flex-[1_1_480px] flex-col gap-3.5">
        {error && (
          <div className="te-note te-note--warn" role="alert">
            <span>
              <strong>The library could not be read.</strong> {error}
            </span>
          </div>
        )}

        {ready && <details className="te-glass rounded-[18px] p-4" open={totals?.lectures === 0 ? true : undefined}>
          <summary className="cursor-pointer font-semibold">Getting started</summary>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
            <li>Open a supported video with captions. Click the extension icon and extract its transcript.</li>
            <li>Return here to read, highlight, and add notes. Alt+Shift+N takes a note while watching.</li>
            <li>Use Search to find passages across saved videos. A timestamp returns you to the player.</li>
            <li>Export your notes from the reader. Download a complete backup before switching browsers or removing the extension.</li>
          </ol>
        </details>}
        {!ready ? (
          <p className="te-muted p-1 text-sm">Opening your library…</p>
        ) : view.name === 'library' ? (
          <LibraryView
            key={libraryVersion}
            totals={totals}
            onOpenLecture={(lectureId) => setView({ name: 'lecture', lectureId })}
            onChanged={refreshTotals}
          />
        ) : (
          // The reading views keep their own layout; they sit on a glass
          // panel so they read cleanly over the page wash.
          <div className="te-glass rounded-[22px] px-6 py-6 md:px-8 md:py-7">
            {view.name === 'lecture' ? (
              <LectureView
                lectureId={view.lectureId}
                onBack={() => setView({ name: 'library' })}
                onChanged={refreshTotals}
              />
            ) : view.name === 'search' ? (
              <SearchView onOpenLecture={(lectureId) => setView({ name: 'lecture', lectureId })} />
            ) : view.name === 'highlights' ? (
              <HighlightsView
                onOpenLecture={(lectureId) => setView({ name: 'lecture', lectureId })}
                onGoToLibrary={() => setView({ name: 'library' })}
              />
            ) : (
              <NotesView
                onOpenLecture={(lectureId) => setView({ name: 'lecture', lectureId })}
                onGoToLibrary={() => setView({ name: 'library' })}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
};

/** `3.2 MB`, for the storage note in the sidebar. */
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
