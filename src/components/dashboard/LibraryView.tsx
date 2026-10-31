import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Download, Loader2, Search, Trash2, X } from 'lucide-react';
import {
  deleteLecture,
  getTranscript,
  listAllLectures,
  listCourses,
  listHighlights,
  listNotes,
  listScreenshots,
  migrateIntoLibrary,
} from '../../lib/library-db';
import { courseTotals, type CourseRecord, type LectureRecord } from '../../lib/library-schema';
import { buildCourseStudyNotes, type StudyLecture } from '../../lib/study-notes';
import { formatTimestamp } from '../../lib/transcript';
import { ExtensionService } from '../../lib/extension-service';
import { BrandTile } from '../BrandTile';

const PLATFORM_LABELS: Record<string, string> = {
  udemy: 'Udemy',
  coursera: 'Coursera',
  youtube: 'YouTube',
  generic: 'Web',
  unknown: '',
};

type SortOrder = 'recent' | 'name' | 'oldest';

/** `Today`, `Yesterday`, `28 Sep` — a library is browsed by day, not by minute. */
function formatDay(ms: number): string {
  const day = new Date(ms);
  const today = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return day.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** `today`, `yesterday`, `on 28 Sep` — for use mid-sentence. */
const dayPhrase = (ms: number): string => {
  const day = formatDay(ms);
  return day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : `on ${day}`;
};

/** Last time anything in a course was extracted. */
const lastCollected = (lectures: LectureRecord[], course: CourseRecord) =>
  lectures.length > 0 ? Math.max(...lectures.map((l) => l.collectedAt)) : course.updatedAt;

/**
 * Read everything a study document needs for these lectures.
 *
 * Per lecture, on demand: drawing the library never touches transcript text,
 * and only an export should start reading it.
 */
async function loadStudyLectures(lectures: LectureRecord[]): Promise<StudyLecture[]> {
  const built: StudyLecture[] = [];
  for (const lecture of lectures) {
    const [transcript, marked, written, shots] = await Promise.all([
      getTranscript(lecture.id).catch(() => undefined),
      listHighlights(lecture.id).catch(() => []),
      listNotes(lecture.id).catch(() => []),
      listScreenshots(lecture.id).catch(() => []),
    ]);
    built.push({
      title: lecture.title,
      url: lecture.url,
      transcript: transcript?.text ?? '',
      highlights: marked,
      notes: written,
      screenshots: shots,
    });
  }
  return built;
}

interface LibraryViewProps {
  totals: { courses: number; lectures: number; words: number } | null;
  onOpenLecture: (lectureId: string) => void;
  /** Called after anything is deleted, so the sidebar counts stay true. */
  onChanged: () => void;
}

/**
 * Everything collected, grouped by course — and the place to prune it.
 *
 * Built from lecture metadata alone; no transcript is read to draw this
 * screen, which is the whole reason transcripts live in their own store.
 */
export const LibraryView: React.FC<LibraryViewProps> = ({ totals, onOpenLecture, onChanged }) => {
  const [courses, setCourses] = useState<CourseRecord[] | null>(null);
  const [lectures, setLectures] = useState<LectureRecord[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState<string>('all');
  const [sort, setSort] = useState<SortOrder>('recent');

  /** What is being written out, so its button can say so. */
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void migrateIntoLibrary().catch(console.error).finally(async () => {
      try {
        const [foundCourses, foundLectures] = await Promise.all([listCourses(), listAllLectures()]);
        if (cancelled) return;
        setCourses(foundCourses);
        setLectures(foundLectures);
        // Open the course worked on most recently: a library is opened to
        // continue something.
        if (foundLectures.length > 0) setExpanded(new Set([foundLectures[0].courseId]));
      } catch {
        if (!cancelled) setCourses([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Lectures per course, in course order where it is known. */
  const byCourse = useMemo(() => {
    const groups = new Map<string, LectureRecord[]>();
    for (const lecture of lectures) {
      const group = groups.get(lecture.courseId) ?? [];
      group.push(lecture);
      groups.set(lecture.courseId, group);
    }
    for (const group of groups.values()) {
      group.sort(
        (a, b) =>
          (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
          b.collectedAt - a.collectedAt,
      );
    }
    return groups;
  }, [lectures]);

  const platforms = useMemo(
    () => [...new Set((courses ?? []).map((c) => c.platform))].filter((p) => PLATFORM_LABELS[p]),
    [courses],
  );

  /** Courses after search, filter and sort, each with the lectures to show. */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = (courses ?? [])
      .filter((course) => platform === 'all' || course.platform === platform)
      .map((course) => {
        const all = byCourse.get(course.id) ?? [];
        if (!needle || course.title.toLowerCase().includes(needle)) return { course, shown: all, all };
        return { course, shown: all.filter((l) => l.title.toLowerCase().includes(needle)), all };
      })
      .filter((row) => row.shown.length > 0);

    rows.sort((a, b) => {
      if (sort === 'name') return a.course.title.localeCompare(b.course.title);
      const diff = lastCollected(a.all, a.course) - lastCollected(b.all, b.course);
      return sort === 'oldest' ? diff : -diff;
    });
    return rows;
  }, [courses, byCourse, query, platform, sort]);

  const searching = query.trim().length > 0;

  const toggleExpanded = (courseId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(courseId)) next.delete(courseId);
      else next.add(courseId);
      return next;
    });

  const toggleSelected = (ids: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  /** One Markdown document, a section per course, for any set of lectures. */
  const exportLectures = async (chosen: LectureRecord[], filenameTitle: string, key: string) => {
    if (chosen.length === 0) return;
    setBusy(key);
    try {
      const documents: string[] = [];
      for (const course of courses ?? []) {
        const inCourse = (byCourse.get(course.id) ?? []).filter((l) => chosen.includes(l));
        if (inCourse.length === 0) continue;
        // `instructor` only: the course title is already the heading.
        documents.push(
          buildCourseStudyNotes(await loadStudyLectures(inCourse), {
            title: course.title,
            instructor: course.instructor,
          }),
        );
      }
      ExtensionService.downloadFile(
        documents.join('\n\n---\n\n'),
        ExtensionService.generateFilename(filenameTitle, 'markdown'),
        'text/markdown',
      );
    } finally {
      setBusy(null);
    }
  };

  const deleteLectures = async (chosen: LectureRecord[]) => {
    if (deleting) return;
    const message =
      chosen.length === 1
        ? `Delete "${chosen[0].title}" and its transcript, notes and screenshots?`
        : `Delete ${chosen.length} lectures and their transcripts, notes and screenshots?`;
    if (!window.confirm(message)) return;

    setDeleting(true);
    setDeleteError(null);

    const removed = new Set<string>();
    for (const lecture of chosen) {
      try {
        await deleteLecture(lecture.id);
        removed.add(lecture.id);
      } catch (err) {
        console.error('Failed to delete lecture:', err);
        setDeleteError(err instanceof Error ? err.message : 'Deletion failed. Please retry.');
      }
    }

    const remaining = lectures.filter((l) => !removed.has(l.id));
    setLectures(remaining);
    // `deleteLecture` drops a course once its last lecture goes; mirror that.
    const stillUsed = new Set(remaining.map((l) => l.courseId));
    setCourses((current) => (current ? current.filter((c) => stillUsed.has(c.id)) : current));
    toggleSelected([...removed], false);
    onChanged();
    setDeleting(false);
  };

  if (courses === null) {
    return <p className="te-muted p-1 text-sm">Reading your library…</p>;
  }

  if (courses.length === 0) {
    return (
      <div className="flex min-h-[60vh] max-w-md flex-col justify-center gap-3 px-1">
        <BrandTile />
        <h1 className="m-0 text-[26px] font-semibold tracking-[-0.02em]">Your library is empty</h1>
        <p className="m-0 leading-relaxed" style={{ color: 'var(--te-text-2)' }}>
          Open a lecture on Udemy, Coursera or YouTube, then click the extension and extract its
          transcript. Everything you collect lands here — grouped by course, searchable, and never
          leaving this machine.
        </p>
      </div>
    );
  }

  const selectedLectures = lectures.filter((l) => selected.has(l.id));
  const lastExtracted = lectures.length > 0 ? dayPhrase(lectures[0].collectedAt) : null;

  return (
    <>
      {deleteError && <p role="alert" className="text-sm text-red-600">{deleteError}</p>}
      <div className="flex flex-wrap items-center gap-3 px-1 pt-1.5">
        <div className="flex min-w-[200px] flex-[1_1_200px] flex-col gap-0.5">
          <h1 className="m-0 text-[26px] font-semibold tracking-[-0.02em]">Library</h1>
          <span className="te-muted">
            {[
              totals && `${totals.courses} ${totals.courses === 1 ? 'course' : 'courses'}`,
              totals && `${totals.lectures} ${totals.lectures === 1 ? 'lecture' : 'lectures'}`,
              lastExtracted && `last extracted ${lastExtracted}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void exportLectures(lectures, 'library', 'all')}
          disabled={busy !== null}
          className="te-btn"
        >
          {busy === 'all' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" strokeWidth={1.9} />
          )}
          Export all
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="te-glass flex h-11 min-w-[220px] flex-[1_1_260px] items-center gap-2.5 rounded-[14px] px-3.5">
          <Search className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--te-text-3)' }} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search courses and lectures"
            placeholder="Search courses and lectures"
            className="h-10 min-w-0 flex-grow border-0 bg-transparent outline-none"
            style={{ color: 'var(--te-text)' }}
          />
        </div>
        {platforms.length > 1 && (
          <div role="group" aria-label="Filter by source" className="flex flex-wrap gap-1.5">
            {['all', ...platforms].map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={platform === p}
                onClick={() => setPlatform(p)}
                className="te-filter"
              >
                {p === 'all' ? 'All' : PLATFORM_LABELS[p]}
              </button>
            ))}
          </div>
        )}
        <select
          aria-label="Sort by"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortOrder)}
          className="te-select te-select--inline"
        >
          <option value="recent">Recently extracted</option>
          <option value="name">Course name</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>

      {visible.length === 0 && (
        <p className="te-muted px-1">Nothing in your library matches “{query.trim()}”.</p>
      )}

      {visible.map(({ course, shown, all }) => {
        const open = searching || expanded.has(course.id);
        const ids = shown.map((l) => l.id);
        const picked = ids.filter((id) => selected.has(id)).length;
        const totalsForCourse = courseTotals(all);
        const platformLabel = PLATFORM_LABELS[course.platform] ?? '';
        const numbered = all.some((l) => l.order !== undefined);

        return (
          <section key={course.id} className="te-glass overflow-hidden rounded-[20px]">
            <div className="flex flex-wrap items-center gap-3 py-3.5 pl-4 pr-3">
              <input
                type="checkbox"
                className="te-check"
                aria-label={`Select all lectures in ${course.title}`}
                checked={picked > 0 && picked === ids.length}
                ref={(el) => {
                  if (el) el.indeterminate = picked > 0 && picked < ids.length;
                }}
                onChange={(e) => toggleSelected(ids, e.target.checked)}
              />
              <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
                <h2 className="m-0 truncate text-[16px] font-semibold tracking-[-0.01em]">
                  {course.title}
                </h2>
                <span className="te-muted text-[12px]">
                  {[
                    platformLabel,
                    course.instructor,
                    `${totalsForCourse.lectures} ${totalsForCourse.lectures === 1 ? 'lecture' : 'lectures'} extracted`,
                    `${totalsForCourse.words.toLocaleString()} words`,
                    !open && `last ${dayPhrase(lastCollected(all, course))}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void exportLectures(all, course.title, course.id)}
                disabled={busy !== null}
                className="te-chip-btn te-chip-btn--neutral"
              >
                {busy === course.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Export course
              </button>
              {!searching && (
                <button
                  type="button"
                  onClick={() => toggleExpanded(course.id)}
                  aria-expanded={open}
                  aria-label={open ? `Collapse ${course.title}` : `Expand ${course.title}`}
                  className="te-ghost-icon"
                >
                  {open ? (
                    <ChevronUp className="h-[18px] w-[18px]" strokeWidth={2} />
                  ) : (
                    <ChevronDown className="h-[18px] w-[18px]" strokeWidth={2} />
                  )}
                </button>
              )}
            </div>

            {open && (
              <ul className="m-0 flex list-none flex-col p-0">
                {shown.map((lecture) => {
                  const isPicked = selected.has(lecture.id);
                  return (
                    <li
                      key={lecture.id}
                      className={`te-lecture-row flex flex-wrap items-center gap-3 py-2.5 pl-4 pr-3 ${isPicked ? 'te-row-selected' : ''}`}
                      style={{ borderTop: '1px solid var(--te-divider)' }}
                    >
                      <input
                        type="checkbox"
                        className="te-check"
                        checked={isPicked}
                        aria-label={`Select ${lecture.title}`}
                        onChange={(e) => toggleSelected([lecture.id], e.target.checked)}
                      />
                      {/* Position only when the course told us; extraction
                          order is not course order. */}
                      {numbered && (
                        <span className="te-mono te-muted w-[22px] text-[12px]">
                          {lecture.order ?? ''}
                        </span>
                      )}
                      <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-px">
                        <button
                          type="button"
                          onClick={() => onOpenLecture(lecture.id)}
                          className="truncate text-left font-medium hover:underline"
                          style={{ color: 'var(--te-text)' }}
                        >
                          {lecture.title}
                        </button>
                        <span className="te-muted text-[12px]">
                          {[
                            lecture.durationSeconds ? formatTimestamp(lecture.durationSeconds) : null,
                            `${lecture.wordCount.toLocaleString()} words`,
                            lecture.completedAt ? 'Done' : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </div>
                      <span className="te-muted w-[84px] text-[12px]">
                        {formatDay(lecture.collectedAt)}
                      </span>
                      <button
                        type="button"
                        onClick={() => void exportLectures([lecture], lecture.title, lecture.id)}
                        disabled={busy !== null}
                        aria-label={`Download ${lecture.title}`}
                        className="te-ghost-icon"
                      >
                        {busy === lecture.id ? (
                          <Loader2 className="h-[17px] w-[17px] animate-spin" />
                        ) : (
                          <Download className="h-[17px] w-[17px]" strokeWidth={1.9} />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteLectures([lecture])}
                        disabled={deleting}
                        aria-label={`Delete ${lecture.title}`}
                        className="te-ghost-icon te-ghost-icon--danger"
                      >
                        <Trash2 className="h-[17px] w-[17px]" strokeWidth={1.9} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      {selectedLectures.length > 0 && (
        <div role="toolbar" aria-label="Actions for selected lectures" className="te-selection-bar mt-auto">
          <span className="pr-2 font-medium">
            {selectedLectures.length} {selectedLectures.length === 1 ? 'lecture' : 'lectures'} selected
          </span>
          <button
            type="button"
            onClick={() => void exportLectures(selectedLectures, 'selected_lectures', 'selection')}
            disabled={busy !== null}
          >
            {busy === 'selection' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" strokeWidth={1.9} />
            )}
            Export
          </button>
          <button type="button" onClick={() => void deleteLectures(selectedLectures)} disabled={deleting} className="te-danger">
            <Trash2 className="h-4 w-4" strokeWidth={1.9} />
            Delete
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            aria-label="Clear selection"
            className="te-clear"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
      )}
    </>
  );
};
