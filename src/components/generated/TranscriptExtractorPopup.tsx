'use client';

import * as React from 'react';
import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Sun,
  Moon,
  Settings,
  Download,
  Copy,
  AlertCircle,
  Check,
  Circle,
  Clock,
  Search,
  Loader2,
  ArrowRight,
  ChevronRight,
  ChevronDown,
  Camera,
  ScanText,
  Library,
  FileText,
  Info,
  ListOrdered,
  X,
  Sparkles,
  RefreshCw,
  Square,
} from 'lucide-react';
import {
  type BatchState,
  getBatchProgress,
  batchForCourse,
  getBatchState,
  BATCH_STORAGE_KEY,
} from '../../lib/batch-service';
import { VideoDownload } from '../VideoDownload';
import { SubscriptionSettings } from '../SubscriptionSettings';
import { StorageService } from '../../lib/storage-service';
import type { ExportFormat } from '../../lib/extension-service';
import { formatTimestamp, parseTranscript, type SourceMeta } from '../../lib/transcript';
import {
  addLecture,
  lectureId,
  loadCollection,
  saveCollection,
  totalWords,
  type CollectedLecture,
} from '../../lib/collection';
import { TranscriptSearch } from '../TranscriptSearch';
import { BrandTile } from '../BrandTile';
import {
  allFrames,
  captureCurrentFrame,
  deleteFrame,
  framesForLecture,
  readAndStoreFrame,
} from '../../lib/frame-service';
import { planFrameExport, type CapturedFrame } from '../../lib/frame-capture';
import { probeImageModel, startModelDownload, type AiProbe } from '../../lib/on-device-ai';
import { createZip, dataUrlBytes, textBytes } from '../../lib/zip';
import { searchService } from '../../lib/search-service';
import { applyTheme, storeTheme } from '../../lib/theme';
import { lectureActivity, setLectureComplete } from '../../lib/library-db';
import {
  countWords,
  lectureStatus,
  STATUS_LABELS,
  type LectureActivity,
} from '../../lib/library-schema';
import {
  loadCourseCollection,
  removeCourseLecture,
  saveCourseLecture,
} from '../../lib/collection-store';

// Helper function for dynamic ExtensionService import
const getExtensionService = async () => {
  const { ExtensionService } = await import('../../lib/extension-service');
  return ExtensionService;
};

/** What each export is for, shown under the picker so the choice is obvious. */
/** Short name for the collapsed export row, so the choice stays visible. */
const FORMAT_LABELS: Record<ExportFormat, string> = {
  markdown: 'Markdown',
  organized: 'Organized notes',
  obsidian: 'Obsidian',
  txt: 'Plain text',
  json: 'JSON',
  rag: 'Retrieval chunks',
  srt: 'SubRip',
  vtt: 'WebVTT',
  csv: 'Spreadsheet',
  anki: 'Anki cards',
};

const FORMAT_HINTS: Record<ExportFormat, string> = {
  markdown:
    'Readable notes with plain-text timestamps. Best for pasting into ChatGPT, Claude or Notion.',
  organized:
    'The transcript rewritten as notes: headings per topic, time ranges, paragraphs. Still the lecturer’s words.',
  obsidian:
    'Markdown plus YAML properties and a contents list, so a course drops straight into a vault.',
  txt: 'Plain text, no formatting. Works anywhere.',
  rag: 'Pre-chunked with context headers and timestamps, ready for a vector store or NotebookLM.',
  srt: 'Standard subtitle file for video editors and players.',
  vtt: 'Web subtitle format, for HTML5 players.',
  csv: 'One row per line with timestamps and links. Imports into Excel, Sheets, Anki, or Quizlet.',
  json: 'Structured cues for your own scripts.',
  anki: 'Fill-in-the-blank flashcards built from the lecture, ready to import into Anki.',
};

/** `mm:ss`, or `h:mm:ss` past an hour — the label on a captured still. */
const formatClockLabel = (seconds: number): string => {
  const safe = Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(safe / 3600);
  const mm = String(Math.floor((safe % 3600) / 60)).padStart(2, '0');
  const ss = String(safe % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/** Narrow the content script's platform string to the exported metadata type. */
const toPlatform = (value?: string): SourceMeta['platform'] =>
  value === 'udemy' || value === 'youtube' || value === 'coursera' || value === 'generic'
    ? value
    : 'unknown';

// Simple debouncing utility
const debounce = (func: (...args: unknown[]) => void, wait: number) => {
  let timeout: ReturnType<typeof setTimeout>;
  return (...args: unknown[]) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};

/** The arc spinner from the design, in the accent colour. */
const Spinner = ({ size = 18 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--te-accent)"
    strokeWidth="2.4"
    strokeLinecap="round"
    className="flex-shrink-0 animate-spin"
    aria-hidden="true"
  >
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
);

/** A labelled on/off row. The checkbox is real; the track is decoration. */
const SwitchRow = ({
  label,
  hint,
  checked,
  onChange,
  className = '',
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  className?: string;
}) => (
  <label
    className={`flex min-h-[52px] cursor-pointer items-center gap-3 py-1.5 pl-4 pr-3.5 ${className}`}
  >
    <span className="flex flex-grow flex-col">
      <span className="text-[14px] font-medium">{label}</span>
      <span className="te-muted text-[12px]">{hint}</span>
    </span>
    <input
      type="checkbox"
      role="switch"
      className="te-switch-input"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
    <span className="te-switch" aria-hidden="true" />
  </label>
);

/** Display name for the platform the content script reported. */
const PLATFORM_NAMES: Record<string, string> = {
  udemy: 'Udemy',
  youtube: 'YouTube',
  coursera: 'Coursera',
  generic: 'Web video',
};

/** `~3 min left`, from the average time per processed lecture so far. */
const estimateTimeLeft = (state: BatchState, processed: number, total: number): string | null => {
  if (processed === 0 || processed >= total) return null;
  const perLecture = (Date.now() - state.startedAt) / processed;
  const minutes = Math.round((perLecture * (total - processed)) / 60000);
  return minutes < 1 ? 'under a minute left' : `~${minutes} min left`;
};

export const TranscriptExtractorPopup = () => {
  const [isDarkMode, setIsDarkMode] = useState(false);

  const [includeTimestamps, setIncludeTimestamps] = useState(true);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('markdown');
  const [exportTarget, setExportTarget] = useState<'clipboard' | 'download'>('clipboard');
  const [showFormatDropdown, setShowFormatDropdown] = useState(false);

  const [isExtracting, setIsExtracting] = useState(false);
  const [availability, setAvailability] = useState<{
    platform: string;
    hasTranscript: boolean;
    isCoursePage: boolean;
  } | null>(null);
  const [currentVideo, setCurrentVideo] = useState<{ title: string; duration: string } | null>(
    null
  );
  const [courseStructure, setCourseStructure] = useState<any>(null);
  const [isCourseStructureLoading, setIsCourseStructureLoading] = useState(false);
  const [extractedTranscript, setExtractedTranscript] = useState<string>('');
  const [extractionStatus, setExtractionStatus] = useState<
    'idle' | 'extracting' | 'success' | 'error'
  >('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');

  // Source page URL, used to build timestamped deep links in exports.
  const [pageUrl, setPageUrl] = useState<string | null>(null);

  // Transcripts gathered across this course, so exports cover the whole thing
  // rather than whichever lecture happened to be open last.
  const [collection, setCollection] = useState<CollectedLecture[]>([]);

  // Simple navigation state
  const [isNavigating, setIsNavigating] = useState(false);

  // Semantic search over the extracted transcript, running locally on CPU.
  const [showSearch, setShowSearch] = useState(false);

  // Stills captured from the video. A transcript cannot show a line of code or
  // a diagram, which is most of what a programming lecture is made of.
  const [frames, setFrames] = useState<CapturedFrame[]>([]);
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureNote, setCaptureNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(
    null,
  );

  const currentLectureId = useMemo(
    () => lectureId(pageUrl ?? undefined, currentVideo?.title ?? 'lecture'),
    [pageUrl, currentVideo?.title],
  );

  const [batchState, setBatchState] = useState<BatchState | null>(null);
  const [unsaved, setUnsaved] = useState<CollectedLecture | null>(null);
  const [saving, setSaving] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const [autoDownload, setAutoDownload] = useState<boolean>(() => {
    try {
      return localStorage.getItem('batch_auto_download') === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let disposed = false;
    void getBatchState().then(state => {
      if (!disposed) setBatchState(batchForCourse(state, pageUrl));
    }).catch(error => {
      if (!disposed) setErrorMessage(error instanceof Error ? error.message : 'Could not read collection progress.');
    });

    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName === 'local') {
        if (changes[BATCH_STORAGE_KEY]) {
          const nextBatch = (changes[BATCH_STORAGE_KEY].newValue as BatchState | undefined) ?? null;
          setBatchState(batchForCourse(nextBatch, pageUrl));
        }
        if (pageUrl) {
          void loadCourseCollection(pageUrl, {
            courseTitle: courseStructure?.title,
            instructor: courseStructure?.instructor,
          }).then(setCollection);
        }
      }
    };

    chrome.storage?.onChanged?.addListener(listener);
    return () => {
      disposed = true;
      chrome.storage?.onChanged?.removeListener(listener);
    };
  }, [pageUrl, courseStructure]);

  const [sourceTabId, setSourceTabId] = useState<number>();
  const [downloadBusy, setDownloadBusy] = useState(false);
  useEffect(() => {
    if (downloadBusy) return;
    const update = () => {
      void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.id !== undefined && tab.url?.startsWith('https:')) setSourceTabId(tab.id);
      });
    };
    update();
    chrome.tabs.onActivated.addListener(update);
    return () => chrome.tabs.onActivated.removeListener(update);
  }, [downloadBusy]);
  const handleStartEntireCourse = async () => {
    try {
      const service = await getExtensionService();
      const result = await service.startBatchExtraction({
        autoDownload,
        exportFormat,
      });
      if (!result.success) throw new Error(result.error || 'Could not start collection.');
      setErrorMessage('');
      setBatchState(batchForCourse(await getBatchState(), pageUrl));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to start collection');
    }
  };

  const handleAutoDownloadChange = (next: boolean) => {
    setAutoDownload(next);
    try {
      localStorage.setItem('batch_auto_download', next ? 'true' : 'false');
    } catch {
      // Ignore storage failures; the toggle state already changed in memory.
    }
    // A running batch re-reads its state from storage on every step and checks
    // `autoDownload` when it finishes, so changing it mid-run takes effect.
    if (batchState?.isActive) {
      void getExtensionService().then(service => service.setBatchOptions(next)).then(result => {
        if (!result.success) setErrorMessage(result.error || 'Could not update collection options.');
      }).catch(() => setErrorMessage('Could not update collection options.'));
    }
  };

  const handleCancelBatch = async () => {
    try {
      const service = await getExtensionService();
      const result = await service.cancelBatchExtraction();
      if (!result.success) throw new Error(result.error);
      setBatchState(batchForCourse(await getBatchState(), pageUrl));
    } catch {
      setErrorMessage('Failed to cancel course extraction');
    }
  };

  const handleResume = async (retryFailed = false) => {
    try {
      const result = await (await getExtensionService()).resumeBatchExtraction(retryFailed);
      if (!result.success) throw new Error(result.error || 'Could not resume collection.');
      setBatchState(batchForCourse(await getBatchState(), pageUrl));
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not resume collection.');
    }
  };

  const retrySave = async () => {
    if (!unsaved) return;
    setSaving(true);
    try {
      const next = addLecture(collection, unsaved);
      await saveCourseLecture(unsaved, next, unsaved.url, {
        courseTitle: courseStructure?.title, instructor: courseStructure?.instructor,
      });
      setCollection(next);
      setUnsaved(null);
      setErrorMessage('');
    } catch {
      setErrorMessage('Transcript is extracted but not saved. Retry or download a recovery copy.');
    } finally { setSaving(false); }
  };

  // Can this browser read a screenshot on its own? Checked, never assumed:
  // Chrome's on-device model is absent on plenty of machines, so anything
  // built on it has to be an enhancement rather than a promise. Probing does
  // not start the model download.
  const [aiProbe, setAiProbe] = useState<AiProbe | null>(null);
  const [isInstallingModel, setIsInstallingModel] = useState(false);
  const [installProgress, setInstallProgress] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    probeImageModel().then((probe) => {
      if (!cancelled) setAiProbe(probe);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Chrome will not fetch the model on its own — it sits at "Pending Usage"
  // until something asks for it. This is that ask, and it is a button rather
  // than something automatic because about 4 GB crosses the network.
  const handleInstallModel = async () => {
    setIsInstallingModel(true);
    setInstallProgress(null);
    try {
      setAiProbe(await startModelDownload(setInstallProgress));
    } finally {
      setIsInstallingModel(false);
    }
  };

  // Reload stills whenever the lecture changes, so the strip always shows the
  // frames belonging to the video on screen.
  useEffect(() => {
    let cancelled = false;
    framesForLecture(currentLectureId)
      .then((stored) => {
        if (!cancelled) setFrames(stored);
      })
      .catch(() => {
        if (!cancelled) setFrames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentLectureId]);

  const handleCaptureFrame = async () => {
    setIsCapturing(true);
    setCaptureNote(null);
    try {
      const result = await captureCurrentFrame(currentLectureId);
      if (result.verdict === 'ok' && result.frame) {
        setFrames(await framesForLecture(currentLectureId));
        setCaptureNote({ tone: 'ok', text: 'Frame captured.' });
      } else {
        setCaptureNote({
          tone: 'warn',
          text: result.message ?? 'That frame could not be captured.',
        });
      }
    } catch (error) {
      setCaptureNote({
        tone: 'warn',
        text: error instanceof Error ? error.message : 'That frame could not be captured.',
      });
    } finally {
      setIsCapturing(false);
    }
  };

  const handleDeleteFrame = async (seconds: number) => {
    await deleteFrame(currentLectureId, seconds);
    setFrames(await framesForLecture(currentLectureId));
  };

  // Frames the model has not looked at yet. `undefined` is "not attempted";
  // an empty string is "read, nothing legible" and is not retried.
  const unreadFrames = frames.filter((frame) => frame.readout === undefined);
  const [isReadingFrames, setIsReadingFrames] = useState(false);
  const [readProgress, setReadProgress] = useState<{ done: number; total: number } | null>(null);

  // Which still is open for inspection. Transcribed text has to be readable in
  // the popup: a badge saying text was found is not evidence of what it says,
  // and a tooltip is not somewhere anyone checks accuracy.
  const [openFrame, setOpenFrame] = useState<number | null>(null);

  // Organising loads the 30 MB embedding model if search has not already done
  // so. Without a working state the buttons look broken for a second or two.
  const [isExporting, setIsExporting] = useState(false);

  /**
   * Whether the user has chosen export settings during this popup session.
   *
   * Restoring saved state is asynchronous, and the popup is usable before it
   * resolves. Without this guard a choice made in that window is silently
   * reverted a moment later: you pick a format, the restore lands, the select
   * snaps back, and the export uses the old format with no sign anything
   * happened.
   */
  const userChoseSettings = useRef(false);
  const inspected = frames.find((frame) => frame.seconds === openFrame) ?? null;

  const handleReadFrames = async () => {
    const queue = frames.filter((frame) => frame.readout === undefined);
    if (queue.length === 0) return;

    setIsReadingFrames(true);
    setReadProgress({ done: 0, total: queue.length });
    setCaptureNote(null);

    let failure: string | null = null;
    for (let i = 0; i < queue.length; i += 1) {
      const result = await readAndStoreFrame(queue[i]);
      if (result.error) failure = result.error;
      setReadProgress({ done: i + 1, total: queue.length });
    }

    setFrames(await framesForLecture(currentLectureId));
    setIsReadingFrames(false);
    setReadProgress(null);
    setCaptureNote(
      failure
        ? { tone: 'warn', text: failure }
        : { tone: 'ok', text: 'Screenshots read. The text is included when you export.' },
    );
  };


  const handleThemeToggle = () => {
    const next = isDarkMode ? 'light' : 'dark';
    setIsDarkMode(next === 'dark');
    storeTheme(next);
  };

  // Check availability when component mounts and load saved state
  useEffect(() => {
    // One implementation, shared with the dashboard.
    //
    // The popup used to decide this itself with `saved === 'dark'`, which
    // ignores the system preference entirely. Two surfaces of the same
    // extension, on the same origin, could therefore disagree about the theme
    // — the popup opening dark and the library opening light.
    setIsDarkMode(applyTheme() === 'dark');

    loadSavedState();
    checkPageAvailability();

    return () => {
      setExtractionStatus('idle');
      setExtractedTranscript('');
    };
  }, []);

  // Auto-save course structure when it changes
  useEffect(() => {
    if (courseStructure) {
      StorageService.saveCourseStructure(courseStructure);
    }
  }, [courseStructure]);

  // Auto-save UI preferences when they change
  useEffect(() => {
    StorageService.saveState({
      exportFormat,
      exportTarget,
      includeTimestamps,
      extractedTranscript,
      extractionStatus,
    });
  }, [exportFormat, exportTarget, includeTimestamps, extractedTranscript, extractionStatus]);

  // Load saved state from Chrome storage
  const loadSavedState = async () => {
    try {
      const savedState = await StorageService.loadState();

      // Never overwrite a choice the user has already made this session.
      if (!userChoseSettings.current) {
        setExportFormat(savedState.exportFormat);
        setExportTarget(savedState.exportTarget);
        setIncludeTimestamps(savedState.includeTimestamps);
      }

      if (savedState.extractedTranscript && savedState.extractedTranscript.trim().length > 0) {
        setExtractedTranscript(savedState.extractedTranscript);
        setExtractionStatus(savedState.extractionStatus === 'success' ? 'success' : 'idle');
      } else {
        setExtractedTranscript('');
        setExtractionStatus('idle');
      }

      if (savedState.courseStructure) {
        setCourseStructure(savedState.courseStructure);
      }
      if (savedState.currentVideo) {
        setCurrentVideo(savedState.currentVideo);
      }
      if (savedState.availability) {
        setAvailability(savedState.availability);
      }
    } catch (error) {
      // Failed to load saved state
    }
  };

  const checkPageAvailability = async () => {
    try {
      setExtractionStatus('extracting');
      setErrorMessage('');

      const response = await (await getExtensionService()).checkAvailability();
      const url = await (await getExtensionService()).getCurrentTabUrl();
      setPageUrl(url);
      // Reads the indexed library, migrating this course across on first sight
      // and falling back to the old storage if anything goes wrong.
      setCollection(
        await loadCourseCollection(url ?? undefined, {
          courseTitle: courseStructure?.title,
          instructor: courseStructure?.instructor,
        }),
      );

      if (response.success && response.data) {
        setAvailability(response.data);
        setExtractionStatus('idle');

        if (response.data.isCoursePage) {
          const videoInfo = await (await getExtensionService()).getVideoInfo();
          if (videoInfo.success && videoInfo.data) {
            setCurrentVideo(videoInfo.data);
          }

          setIsCourseStructureLoading(true);
          const courseResponse = await (await getExtensionService()).extractCourseStructure();
          if (courseResponse.success && courseResponse.data) {
            setCourseStructure(courseResponse.data);
          } else {
            setCourseStructure({ title: 'Unknown Course', sections: [] });
          }
          setIsCourseStructureLoading(false);
        }
      } else {
        setErrorMessage(response.error || 'Could not detect page type');
        setExtractionStatus('error');
        setAvailability({
          platform: 'unknown',
          hasTranscript: false,
          isCoursePage: false,
        });
      }
    } catch (error) {
      setErrorMessage('Extension communication failed');
      setExtractionStatus('error');
      setAvailability({
        platform: 'unknown',
        hasTranscript: false,
        isCoursePage: false,
      });
    }
  };

  const handleDeleteCurrentLecture = async () => {
    if (!window.confirm('Delete this lecture and its transcript from your library?')) return;
    const id = lectureId(pageUrl ?? undefined, currentVideo?.title ?? 'lecture');
    try {
      const next = await removeCourseLecture(id, collection, pageUrl ?? undefined);
      setCollection(next);
      setExtractedTranscript('');
      setExtractionStatus('idle');
      setErrorMessage('');
    } catch (e) {
      console.error('Failed to remove lecture:', e);
    }
  };

  const handleExtractTranscript = async () => {
    setIsExtracting(true);
    setExtractionStatus('extracting');
    setErrorMessage('');

    try {
      const response = await (await getExtensionService()).extractTranscript();

      if (response.success && response.data) {
        setExtractedTranscript(response.data);
        setExtractionStatus('success');

        // Add to the course collection rather than replacing it. Moving to the
        // next lecture used to discard the previous one, which made the tool
        // work per video and not per course.
        const id = lectureId(pageUrl ?? undefined, currentVideo?.title ?? 'lecture');
        const collected = {
          id,
          title: currentVideo?.title || 'Untitled lecture',
          url: pageUrl ?? undefined,
          transcript: response.data,
          collectedAt: Date.now(),
        };
        const next = addLecture(collection, collected);
        setUnsaved(collected);
        setSaving(true);
        await saveCourseLecture(collected, next, pageUrl ?? undefined, {
          courseTitle: courseStructure?.title,
          instructor: courseStructure?.instructor,
        });

        setCollection(next);
        setUnsaved(null);
        setSaving(false);

        if (autoDownload) void handleExport('download', collected);

        try {
          const copied = await (await getExtensionService()).copyToClipboard(response.data);
          if (!copied) {
            setErrorMessage('Transcript extracted but failed to copy to clipboard');
          }
        } catch (clipboardError) {
          setErrorMessage('Transcript extracted but failed to copy to clipboard');
        }
      } else {
        setErrorMessage(response.error || 'Failed to extract transcript');
        setExtractionStatus('error');
      }
    } catch (error) {
      setErrorMessage('Extraction or saving failed. If text was captured, use Retry save or Download recovery copy.');
      setExtractionStatus('error');
    } finally {
      setSaving(false);
      setIsExtracting(false);
    }
  };

  /**
   * `only` exports a single lecture instead of the course collection — used by
   * auto-download, which fires before React state has caught up with the
   * transcript that was just extracted.
   */
  const handleExport = async (
    action: 'clipboard' | 'download',
    only?: { id: string; title: string; url?: string; transcript: string },
  ) => {
    if (!extractedTranscript && !only) {
      setErrorMessage('No transcript available to export');
      return;
    }

    const service = await getExtensionService();

    // One list, used for both the document and the screenshot archive. They
    // have to describe the same set of lectures or the images in the export
    // point at sections that are not there.
    const exportedLectures = only
      ? [only]
      : collection.length > 0
        ? collection
        : [
            {
              id: currentLectureId,
              title: currentVideo?.title ?? 'Transcript',
              url: pageUrl ?? undefined,
              transcript: extractedTranscript,
            },
          ];

    // Organised notes are built by the search service, not the formatter: they
    // need the embedding model to find where the topic turns, and the
    // formatter is synchronous and model-free by design.
    //
    // One document per lecture, because section boundaries and time ranges are
    // meaningless across videos whose clocks both start at zero.
    if (exportFormat === 'organized') {
      setIsExporting(true);
      try {
        const parts: string[] = [];
        for (const lecture of exportedLectures) {
          if (!lecture.transcript) continue;
          const notes = await searchService.organize(lecture.transcript, {
            title: lecture.title,
            courseTitle: courseStructure?.title,
            instructor: courseStructure?.instructor,
            url: lecture.url,
            savedAt: new Date().toLocaleString(),
          });
          if (notes.trim()) parts.push(notes.trim());
        }

        if (parts.length === 0) {
          setErrorMessage('There was nothing to organise.');
          return;
        }

        const organized = parts.join('\n\n---\n\n') + '\n';
        const filename = service.generateFilename(
          currentVideo?.title || 'transcript',
          'organized',
        );

        if (action === 'clipboard') {
          const copied = await service.copyToClipboard(organized);
          setErrorMessage(copied ? '' : 'Failed to copy to clipboard');
        } else {
          service.downloadFile(organized, filename, service.getMimeType('organized'));
          setErrorMessage('');
        }
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? `Could not organise: ${error.message}` : 'Could not organise.',
        );
      } finally {
        setIsExporting(false);
      }
      return;
    }

    const formattedTranscript = service.formatCollection(
      exportedLectures,
      exportFormat,
      includeTimestamps,
      {
        url: pageUrl ?? undefined,
        platform: toPlatform(availability?.platform),
        courseTitle: courseStructure?.title,
        instructor: courseStructure?.instructor,
      }
    );

    try {
      switch (action) {
        case 'clipboard': {
          // The clipboard cannot carry image files, but it can carry what was
          // read off them — which is the part a chat window or a notes app can
          // actually use.
          const plan = planFrameExport(formattedTranscript, await allFrames(), {
            lectures: exportedLectures,
            includeImages: false,
          });

          const copied = await service.copyToClipboard(plan.markdown);
          if (!copied) {
            setErrorMessage('Failed to copy to clipboard');
          } else {
            setErrorMessage('');
          }
          break;
        }

        case 'download': {
          const service = await getExtensionService();
          const filename = service.generateFilename(
            currentVideo?.title || 'transcript',
            exportFormat
          );

          // With screenshots, the deliverable is a folder, not a file: the
          // document plus the images it references. Data URIs were the other
          // option and would inflate a course export beyond usefulness.
          const documentFormat =
            exportFormat === 'markdown' || exportFormat === 'obsidian' || exportFormat === 'txt';

          // Screenshots come from every lecture in the export, not just the one
          // on screen. `planFrameExport` drops any frame whose lecture is not
          // part of this document, and names the files so two lectures cannot
          // collide on a frame captured at the same second.
          const exportFrames = await allFrames();
          const plan = planFrameExport(formattedTranscript, exportFrames, {
            lectures: exportedLectures,
          });

          if (plan.files.length > 0 && documentFormat) {
            const archive = createZip([
              { name: filename, data: textBytes(plan.markdown) },
              ...plan.files.map((file) => ({
                name: file.path,
                data: dataUrlBytes(file.frame.dataUrl),
              })),
            ]);
            service.downloadBytes(
              archive,
              filename.replace(/\.[^.]+$/, '') + '.zip',
              'application/zip'
            );
          } else {
            const mimeType = service.getMimeType(exportFormat);
            service.downloadFile(formattedTranscript, filename, mimeType);
          }
          setErrorMessage('');
          break;
        }
      }
    } catch (error) {
      setErrorMessage('Export failed');
    }
  };

  // Download all transcripts combined in 1 file, with filename containing the title of each segment in the file
  const handleDownloadAllCombined = async () => {
    const service = await getExtensionService();
    const lecturesToExport =
      collection.length > 0
        ? collection
        : extractedTranscript
          ? [
              {
                id: currentLectureId,
                title: currentVideo?.title ?? 'Transcript',
                url: pageUrl ?? undefined,
                transcript: extractedTranscript,
              },
            ]
          : [];

    if (lecturesToExport.length === 0) {
      setErrorMessage('No transcripts available to download');
      return;
    }

    try {
      const formattedTranscript = service.formatCollection(
        lecturesToExport,
        exportFormat,
        includeTimestamps,
        {
          url: pageUrl ?? undefined,
          platform: toPlatform(availability?.platform),
          courseTitle: courseStructure?.title,
          instructor: courseStructure?.instructor,
        }
      );

      const filename = service.generateCombinedSegmentsFilename(
        lecturesToExport,
        exportFormat,
        courseStructure?.title || currentVideo?.title || 'all_transcripts'
      );

      const documentFormat =
        exportFormat === 'markdown' || exportFormat === 'obsidian' || exportFormat === 'txt';

      const exportFrames = await allFrames();
      const plan = planFrameExport(formattedTranscript, exportFrames, {
        lectures: lecturesToExport,
      });

      if (plan.files.length > 0 && documentFormat) {
        const archive = createZip([
          { name: filename, data: textBytes(plan.markdown) },
          ...plan.files.map((file) => ({
            name: file.path,
            data: dataUrlBytes(file.frame.dataUrl),
          })),
        ]);
        service.downloadBytes(
          archive,
          filename.replace(/\.[^.]+$/, '') + '.zip',
          'application/zip'
        );
      } else {
        const mimeType = service.getMimeType(exportFormat);
        service.downloadFile(formattedTranscript, filename, mimeType);
      }
      setErrorMessage('');
    } catch (err) {
      console.error('Failed to download combined transcripts:', err);
      setErrorMessage('Failed to download combined file');
    }
  };

  // Simple navigation to next lecture
  const handleNextLecture = async () => {
    setIsNavigating(true);
    try {
      const response = await (await getExtensionService()).navigateToNextLecture();
      if (response.success) {
        // Wait for page to load
        setTimeout(async () => {
          await checkPageAvailability();
          setIsNavigating(false);
          // Reset extraction status so user can extract again
          setExtractionStatus('idle');
          setExtractedTranscript('');
          setErrorMessage('Ready to extract next transcript!');
          setTimeout(() => setErrorMessage(''), 2000);
        }, 1500);
      } else {
        setErrorMessage('Failed to navigate to next lecture');
        setIsNavigating(false);
      }
    } catch (error) {
      setErrorMessage('Failed to navigate to next lecture');
      setIsNavigating(false);
    }
  };

  // Render helper, not a component: defining a component inside render
  // remounts the whole subtree on every state change.
  /**
   * What export and search operate on.
   *
   * The collection when there is one, otherwise whatever was just extracted.
   * Gating these on the *current* lecture meant navigating to a new one hid a
   * course's worth of collected transcripts behind an un-extracted page.
   */
  const searchableLectures =
    collection.length > 0
      ? collection.map((l) => ({ title: l.title, url: l.url, transcript: l.transcript }))
      : extractedTranscript
        ? [
            {
              title: currentVideo?.title ?? 'Transcript',
              url: pageUrl ?? undefined,
              transcript: extractedTranscript,
            },
          ]
        : [];

  const hasAnything = searchableLectures.length > 0;

  /**
   * Lectures in the course, when the sidebar has been read.
   *
   * Null when it has not. A progress bar against a denominator we are guessing
   * at is worse than a plain count — it would tell the user they are 1/8
   * through a course that has sixty lectures.
   */
  const totalLectures: number | null = useMemo(() => {
    const sections = courseStructure?.sections;
    if (!Array.isArray(sections)) return batchState?.items.length || null;
    const total = sections.reduce(
      (sum: number, section: { lectures?: unknown[] }) =>
        sum + (Array.isArray(section.lectures) ? section.lectures.length : 0),
      0,
    );
    const knownTotal = Math.max(total, batchState?.items.length ?? 0);
    return knownTotal > 0 ? knownTotal : null;
  }, [courseStructure, batchState]);

  const isBusy = downloadBusy || isExtracting || isNavigating || Boolean(batchState?.isActive && !batchState.isPaused);
  const batchProgress = useMemo(() => getBatchProgress(batchState), [batchState]);
  const isDone = extractionStatus === 'success' && Boolean(extractedTranscript);

  /** Words in the transcript just captured, ignoring timestamp markers. */
  const transcriptWords = useMemo(
    () => (extractedTranscript ? countWords(extractedTranscript) : 0),
    [extractedTranscript],
  );

  /**
   * What is attached to the lecture on screen.
   *
   * Answers "where am I with this one" rather than "what can this extension
   * do" — the counts all come from indexed lookups, so nothing large is read
   * to show them.
   */
  const [activity, setActivity] = useState<LectureActivity | null>(null);

  useEffect(() => {
    let cancelled = false;
    lectureActivity(currentLectureId)
      .then((found) => {
        if (!cancelled) setActivity(found);
      })
      .catch(() => {
        if (!cancelled) setActivity(null);
      });
    return () => {
      cancelled = true;
    };
    // Re-read whenever the lecture changes or something is attached to it.
  }, [currentLectureId, frames.length, collection.length, extractedTranscript]);

  const toggleComplete = async () => {
    if (!activity) return;
    await setLectureComplete(currentLectureId, activity.completedAt === undefined);
    setActivity(await lectureActivity(currentLectureId));
  };

  /**
   * Nothing to extract here.
   *
   * Either the page has no transcript, or an attempt already failed — courses
   * routinely mix in text-only pages. Both cases want the same thing: a way
   * onward, not a disabled button.
   */
  const isBlocked =
    !isBusy && !isDone && (!availability?.hasTranscript || extractionStatus === 'error');

  /** Open the library in a tab, reusing one if it is already open. */
  const openDashboard = () => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) return;
    const url = chrome.runtime.getURL('dashboard.html');
    if (chrome.tabs?.create) void chrome.tabs.create({ url });
    else window.open(url, '_blank');
  };

  const sourceMeta: SourceMeta = {
    title: currentVideo?.title,
    url: pageUrl ?? undefined,
    platform: toPlatform(availability?.platform),
    courseTitle: courseStructure?.title,
    instructor: courseStructure?.instructor,
  };

  // Export settings live behind the gear, not on the main screen: they are
  // chosen once and then left alone, and the design keeps the popup to the
  // one decision that matters per lecture.
  const [view, setView] = useState<'main' | 'settings'>('main');

  /** The first few cues, for the preview on the "ready" screen. */
  const previewCues = useMemo(
    () => (isDone ? parseTranscript(extractedTranscript).slice(0, 3) : []),
    [isDone, extractedTranscript],
  );
  const lineCount = useMemo(
    () => (isDone ? parseTranscript(extractedTranscript).length : 0),
    [isDone, extractedTranscript],
  );

  const platformName = availability ? PLATFORM_NAMES[availability.platform] : undefined;

  /* ------------------------------------------------------------------------ */
  /* Pieces shared between states                                             */
  /* ------------------------------------------------------------------------ */

  const renderHeader = () => (
    <header className="flex items-center gap-2.5 pb-1.5 pl-4 pr-3 pt-3.5">
      <BrandTile />
      <div className="flex min-w-0 flex-grow flex-col gap-px">
        <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">
          Transcript Extractor
        </h1>
        <p className="te-muted flex items-center gap-1.5 text-[12px]">
          <span
            className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
            style={{ background: 'var(--te-success)' }}
            aria-hidden="true"
          />
          <span className="truncate">Runs locally · nothing leaves your browser</span>
        </p>
      </div>
      <button
        type="button"
        onClick={handleThemeToggle}
        className="te-icon-btn"
        aria-label={isDarkMode ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        {isDarkMode ? (
          <Sun className="h-[17px] w-[17px]" strokeWidth={1.8} />
        ) : (
          <Moon className="h-[17px] w-[17px]" strokeWidth={1.8} />
        )}
      </button>

      <button
        type="button"
        onClick={() => setView(view === 'settings' ? 'main' : 'settings')}
        className="te-icon-btn"
        aria-label="Settings"
        aria-pressed={view === 'settings'}
      >
        <Settings className="h-[17px] w-[17px]" strokeWidth={1.8} />
      </button>
    </header>
  );

  const renderError = () =>
    errorMessage ? (
      <div className="te-note te-note--warn" role="alert">
        <AlertCircle className="mt-px h-3.5 w-3.5 flex-shrink-0" />
        <span>{errorMessage}</span>
      </div>
    ) : null;

  /** What we are looking at. `withStatus` adds the captions pill. */
  const renderLectureCard = (withStatus: boolean) => {
    if (!currentVideo && !availability) return null;

    return (
      <div className="te-glass flex flex-col gap-1.5 px-4 py-3.5">
        <div className="te-kicker">{currentVideo ? 'This lecture' : 'This page'}</div>
        <div className="line-clamp-2 text-[16px] font-semibold leading-[1.3] tracking-[-0.01em]">
          {currentVideo?.title ??
            (availability?.hasTranscript ? 'Video with captions' : 'No supported video found')}
        </div>
        <div className="flex items-center gap-3 text-[12px]" style={{ color: 'var(--te-text-2)' }}>
          {platformName && <span>{platformName}</span>}
          {currentVideo?.duration && (
            <span className="te-mono flex items-center gap-1">
              <Clock className="h-[13px] w-[13px]" />
              {currentVideo.duration}
            </span>
          )}
          {withStatus && availability && (
            <span className="ml-auto">
              {availability.hasTranscript ? (
                <span className="te-pill te-pill--ok">
                  <Check className="h-3 w-3" strokeWidth={2.4} />
                  Captions found
                </span>
              ) : (
                <span className="te-pill te-pill--warn">
                  <AlertCircle className="h-3 w-3" />
                  No captions
                </span>
              )}
            </span>
          )}
        </div>
      </div>
    );
  };

  const renderLibraryLink = (title: string, hint: string) => (
    <button
      type="button"
      onClick={openDashboard}
      className="te-glass te-row-link mt-auto flex-shrink-0"
    >
      <span className="te-badge">
        <Library className="h-[18px] w-[18px]" strokeWidth={1.9} />
      </span>
      <span className="flex min-w-0 flex-grow flex-col">
        <span className="font-semibold">{title}</span>
        <span className="te-muted truncate text-[12px]">{hint}</span>
      </span>
      <ChevronRight className="h-[18px] w-[18px] flex-shrink-0" style={{ color: 'var(--te-text-4)' }} />
    </button>
  );

  /** Lectures gathered for this course so far, and a one-file export of them. */
  const renderCollectionCard = () => {
    if (collection.length < 2) return null;
    const percent =
      totalLectures !== null ? Math.min(100, Math.round((collection.length / totalLectures) * 100)) : null;

    return (
      <div className="te-glass flex flex-col gap-2.5 px-4 py-3.5">
        <div className="flex items-baseline gap-2">
          <span className="te-kicker flex-grow">This course</span>
          <span className="te-mono te-muted text-[12px]">
            {totalWords(collection).toLocaleString()} words
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="te-mono text-[20px] font-semibold">{collection.length}</span>
          <span style={{ color: 'var(--te-text-2)' }}>
            {totalLectures !== null ? `of ${totalLectures} lectures collected` : 'lectures collected'}
          </span>
          {percent !== null && (
            <span className="te-mono te-muted ml-auto text-[12px]">{percent}%</span>
          )}
        </div>
        {percent !== null && (
          <div className="te-progress">
            <div style={{ width: `${percent}%` }} />
          </div>
        )}

      </div>
    );
  };

  /** Lectures a finished batch could not extract, and why. */
  const renderSkippedSummary = () => {
    if (!batchState || batchState.isActive || (batchProgress.skipped === 0 && batchProgress.failed === 0)) return null;
    return (
      <div className="te-glass flex flex-col gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setShowSkipped(!showSkipped)}
          aria-expanded={showSkipped}
          className="flex items-center gap-2 text-left text-[13px]"
        >
          <AlertCircle className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--te-warn)' }} />
          <span className="flex-grow">
            Last course run: {batchProgress.completed} saved, {batchProgress.skipped} skipped, {batchProgress.failed} failed
          </span>
          <ChevronDown
            className={`h-4 w-4 flex-shrink-0 transition-transform ${showSkipped ? 'rotate-180' : ''}`}
          />
        </button>
        {showSkipped && (
          <ul className="flex max-h-32 flex-col gap-1.5 overflow-y-auto text-[12px]">
            {batchState.items
              .filter((item) => item.status === 'skipped' || item.status === 'failed')
              .map((item) => (
                <li key={item.id} className="flex flex-col">
                  <span className="truncate font-medium">{item.title}</span>
                  <span style={{ color: 'var(--te-warn-text)' }}>
                    {item.error || 'No captions available'}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </div>
    );
  };

  /** Stills: capture, read with on-device AI, inspect, remove. */
  const renderVisualNotes = () => (
    <div className="flex flex-col gap-2 pb-3.5 pl-4 pr-3.5 pt-3">
      <div className="flex items-center gap-2">
        <span className="flex flex-grow flex-col">
          <span className="text-[14px] font-medium">
            Visual notes <span className="te-muted font-normal">· {frames.length}</span>
          </span>
          <span className="te-muted text-[12px]">
            Capture diagrams and code; exported with the transcript
          </span>
        </span>
        {/* Only offered when the model is installed, so the button is never a
            promise this machine cannot keep. */}
        {aiProbe?.ready && unreadFrames.length > 0 && (
          <button
            type="button"
            onClick={handleReadFrames}
            disabled={isReadingFrames}
            className="te-chip-btn te-chip-btn--neutral"
          >
            {isReadingFrames ? <Spinner size={15} /> : <ScanText className="h-[15px] w-[15px]" />}
            {isReadingFrames && readProgress
              ? `${readProgress.done}/${readProgress.total}`
              : `Read ${unreadFrames.length}`}
          </button>
        )}
        <button
          type="button"
          onClick={handleCaptureFrame}
          disabled={isCapturing}
          className="te-chip-btn"
        >
          {isCapturing ? <Spinner size={15} /> : <Camera className="h-[15px] w-[15px]" strokeWidth={1.9} />}
          Capture
        </button>
      </div>

      {captureNote && (
        <p
          className="text-[12px]"
          style={{ color: captureNote.tone === 'ok' ? 'var(--te-success-text)' : 'var(--te-warn-text)' }}
        >
          {captureNote.text}
        </p>
      )}

      {frames.length > 0 && (
        <ul className="flex gap-2 overflow-x-auto pb-1">
          {frames.map((frame) => (
            <li key={frame.seconds} className="group relative shrink-0">
              <button
                type="button"
                onClick={() => setOpenFrame(openFrame === frame.seconds ? null : frame.seconds)}
                aria-label={`Inspect frame at ${formatClockLabel(frame.seconds)}`}
                aria-pressed={openFrame === frame.seconds}
                className="block"
              >
                <img
                  src={frame.dataUrl}
                  alt=""
                  className="h-14 w-auto rounded-lg"
                  style={{
                    border: `1px solid ${openFrame === frame.seconds ? 'var(--te-accent)' : 'var(--te-divider)'}`,
                  }}
                />
              </button>
              <span className="te-mono absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[9px] text-white">
                {formatClockLabel(frame.seconds)}
              </span>
              {frame.readout ? (
                <span className="pointer-events-none absolute left-1 top-1 rounded bg-emerald-700/90 px-1 text-[9px] font-semibold text-white">
                  text
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => handleDeleteFrame(frame.seconds)}
                aria-label={`Remove frame at ${formatClockLabel(frame.seconds)}`}
                className="absolute -right-1.5 -top-1.5 rounded-full bg-neutral-800 p-0.5 text-white opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* What the model actually read, in full — the only way to judge
          whether a transcription is good enough to keep. */}
      {inspected && (
        <div className="te-note flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="te-kicker flex-grow">On screen at {formatClockLabel(inspected.seconds)}</span>
            <button type="button" onClick={() => setOpenFrame(null)} aria-label="Close frame text">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {inspected.readout === undefined ? (
            <span>
              {aiProbe?.ready
                ? 'Not read yet. Use Read to transcribe it.'
                : 'Not read. On-device AI is not available on this machine.'}
            </span>
          ) : inspected.readout === '' ? (
            <span>Read, but nothing legible was on screen.</span>
          ) : (
            <pre className="te-mono max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed">
              {inspected.readout}
            </pre>
          )}
        </div>
      )}

      {/* Whether this browser can read text off a screenshot. Reported, never
          assumed; nothing is downloaded without a click (~4 GB). */}
      {(aiProbe?.status === 'downloadable' || aiProbe?.status === 'downloading') && (
        <div className="te-note flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="flex-grow">Read text off screenshots with Chrome's on-device model.</span>
            <button
              type="button"
              onClick={handleInstallModel}
              disabled={isInstallingModel}
              className="font-semibold"
              style={{ color: 'var(--te-accent-text)' }}
            >
              {isInstallingModel ? 'Installing…' : 'Install (~4 GB)'}
            </button>
          </div>
          {isInstallingModel && (
            <div className={`te-progress h-1 ${installProgress === null ? 'te-progress--indeterminate' : ''}`}>
              <div
                style={
                  installProgress === null ? undefined : { width: `${Math.round(installProgress * 100)}%` }
                }
              />
            </div>
          )}
        </div>
      )}
      {(aiProbe?.status === 'unavailable' || aiProbe?.status === 'unsupported') && (
        <div className="te-note">
          <Info className="mt-px h-3.5 w-3.5 flex-shrink-0" />
          <span>Auto-descriptions off: {aiProbe.detail}</span>
        </div>
      )}
    </div>
  );

  /* ------------------------------------------------------------------------ */
  /* States                                                                   */
  /* ------------------------------------------------------------------------ */

  /** 1 · Ready to extract (also: no captions, failed, loading next). */
  const renderReady = () => (
    <>
      {renderLectureCard(true)}
      {renderError()}

      <button
        type="button"
        onClick={handleExtractTranscript}
        disabled={isBusy || !availability}
        className="te-btn-primary flex-shrink-0"
      >
        {isNavigating ? (
          <>
            <Loader2 className="h-[18px] w-[18px] animate-spin" />
            Loading next lecture…
          </>
        ) : isBlocked ? (
          <>
            <RefreshCw className="h-[18px] w-[18px]" />
            Retry extraction
          </>
        ) : (
          <>
            <FileText className="h-[18px] w-[18px]" />
            Extract transcript
          </>
        )}
      </button>

      <div className="flex flex-shrink-0 gap-2">
        {availability?.isCoursePage && (
          <button
            type="button"
            onClick={handleStartEntireCourse}
            disabled={isBusy}
            className="te-btn flex-grow"
          >
            <ListOrdered className="h-4 w-4" strokeWidth={1.9} />
            Extract whole course
            {totalLectures ? <span className="te-mono te-muted text-[12px]">{totalLectures}</span> : null}
          </button>
        )}
        <button
          type="button"
          onClick={handleNextLecture}
          disabled={isBusy}
          className={`te-btn ${availability?.isCoursePage ? '' : 'flex-grow'}`}
        >
          Next
          <ArrowRight className="h-4 w-4" strokeWidth={1.9} />
        </button>
      </div>

      {renderSkippedSummary()}

      <div className="te-glass te-divide flex flex-shrink-0 flex-col">

        {renderVisualNotes()}
      </div>

      {renderCollectionCard()}
      {renderLibraryLink('Library', 'Read, search and annotate your transcripts')}
    </>
  );

  /** 2 · Extracting one lecture. */
  const renderExtracting = () => (
    <>
      {renderLectureCard(false)}

      <div role="status" className="te-glass te-glass--strong flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2.5">
          <Spinner />
          <span className="flex-grow font-semibold">Extracting transcript…</span>
        </div>
        <div className="te-progress te-progress--indeterminate">
          <div />
        </div>
        <div className="text-[12px]" style={{ color: 'var(--te-text-2)' }}>
          Reading captions{currentVideo?.duration ? ` · ${currentVideo.duration} of video` : ''}
        </div>
      </div>

      <div className="te-glass flex-shrink-0">

      </div>

      <p className="te-muted px-1 text-[12px]">
        Keep this popup open until the transcript is ready.
      </p>
    </>
  );

  /** 3 · Transcript ready. */
  const renderDone = () => (
    <>
      <div className="flex items-center gap-2.5 px-1 py-0.5">
        <span
          className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full text-white"
          style={{
            background: 'var(--te-success)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.3), 0 4px 12px rgba(30,158,74,0.35)',
          }}
          aria-hidden="true"
        >
          <Check className="h-4 w-4" strokeWidth={2.6} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="font-semibold">Transcript ready</span>
          <span className="te-muted truncate text-[12px]">
            {currentVideo?.title ? `${currentVideo.title} · ` : ''}saved to Library
          </span>
        </span>
      </div>

      {renderError()}

      <div className="te-glass flex-shrink-0 overflow-hidden">
        <div className="flex flex-col gap-2.5 px-4 py-3.5 text-[13px]">
          {previewCues.map((cue, i) => (
            <div key={i} className="flex gap-2.5">
              {cue.startSeconds !== null && (
                <span className="te-mono flex-shrink-0 text-[12px]" style={{ color: 'var(--te-accent-text)' }}>
                  {formatTimestamp(cue.startSeconds)}
                </span>
              )}
              <span className="line-clamp-2">{cue.text}</span>
            </div>
          ))}
        </div>
        <div
          className="flex items-center gap-3 px-4 py-2.5 text-[12px]"
          style={{ borderTop: '1px solid var(--te-divider)', color: 'var(--te-text-2)' }}
        >
          <span>{lineCount.toLocaleString()} lines</span>
          <span>{transcriptWords.toLocaleString()} words</span>
          {frames.length > 0 && (
            <span>
              {frames.length} visual {frames.length === 1 ? 'note' : 'notes'}
            </span>
          )}
          {activity && (
            <button
              type="button"
              onClick={() => void toggleComplete()}
              className="ml-auto font-medium"
              style={{ color: activity.completedAt === undefined ? 'var(--te-accent-text)' : 'var(--te-success-text)' }}
            >
              {activity.completedAt === undefined ? 'Mark done' : `✓ ${STATUS_LABELS[lectureStatus(activity)]}`}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-shrink-0 gap-2">
        <button type="button" onClick={() => handleExport('clipboard')} disabled={isExporting} className="te-btn">
          {isExporting ? <Spinner size={16} /> : <Copy className="h-4 w-4" strokeWidth={1.9} />}
          Copy text
        </button>

      </div>

      <div className="-mt-1 flex items-center gap-1 px-1 text-[12px]">
        <button type="button" onClick={() => setView('settings')} className="te-muted hover:underline">
          As {FORMAT_LABELS[exportFormat]}
        </button>
        <span className="te-muted" aria-hidden="true">·</span>
        <button type="button" onClick={() => setShowSearch(true)} className="te-muted hover:underline">
          Search
        </button>
        <span className="te-muted" aria-hidden="true">·</span>
        <button type="button" onClick={handleExtractTranscript} className="te-muted hover:underline">
          Re-extract
        </button>
        <span className="te-muted" aria-hidden="true">·</span>
        <button type="button" onClick={handleDeleteCurrentLecture} className="te-muted hover:underline">
          Delete
        </button>
      </div>

      <button
        type="button"
        onClick={handleNextLecture}
        disabled={isBusy}
        className="te-btn-primary flex-shrink-0"
      >
        {isNavigating ? (
          <>
            <Loader2 className="h-[18px] w-[18px] animate-spin" />
            Loading next lecture…
          </>
        ) : (
          <>
            Extract next lecture
            <ArrowRight className="h-[18px] w-[18px]" />
          </>
        )}
      </button>

      {renderCollectionCard()}
      {renderLibraryLink('Open in Library', 'Annotate, search and export')}
    </>
  );

  /** 4 · Whole course running in the background. */
  const renderCourse = () => {
    if (!batchState) return null;
    const processed = batchProgress.completed + batchProgress.skipped + batchProgress.failed;
    const current = Math.min(batchState.currentIndex + 1, batchProgress.total);
    const timeLeft = estimateTimeLeft(batchState, processed, batchProgress.total);
    // A window around the lecture being worked on: two behind, two ahead.
    const start = Math.max(0, Math.min(batchState.currentIndex - 2, batchState.items.length - 5));
    const visible = batchState.items.slice(start, start + 5);

    return (
      <>
        <div role="status" className="te-glass te-glass--strong flex flex-col gap-2.5 px-4 py-3.5">
          <div className="te-kicker">Extracting whole course</div>
          <div className="flex items-baseline gap-2">
            <span className="te-mono text-[24px] font-semibold">{current}</span>
            <span style={{ color: 'var(--te-text-2)' }}>of {batchProgress.total} lectures</span>
            {timeLeft && (
              <span className="ml-auto text-[12px]" style={{ color: 'var(--te-text-2)' }}>
                {timeLeft}
              </span>
            )}
          </div>
          <div className="te-progress">
            <div style={{ width: `${batchProgress.percent}%` }} />
          </div>
          {batchProgress.skipped > 0 && (
            <div className="text-[12px]" style={{ color: 'var(--te-warn-text)' }}>
              {batchProgress.skipped} skipped so far
            </div>
          )}
        </div>

        <ol className="te-glass te-divide m-0 flex flex-shrink-0 list-none flex-col overflow-hidden p-0">
          {visible.map((item, offset) => {
            const index = start + offset;
            const active = item.status === 'extracting' || index === batchState.currentIndex;
            return (
              <li
                key={item.id}
                className="flex items-center gap-2.5 px-4 py-[11px] text-[13px]"
                style={
                  active && item.status !== 'completed' && item.status !== 'skipped'
                    ? { background: 'var(--te-accent-soft)', fontWeight: 500 }
                    : { color: item.status === 'pending' ? 'var(--te-text-3)' : 'var(--te-text-2)' }
                }
              >
                {item.status === 'completed' ? (
                  <Check className="h-4 w-4 flex-shrink-0" strokeWidth={2.4} style={{ color: 'var(--te-success)' }} />
                ) : item.status === 'skipped' || item.status === 'failed' ? (
                  <AlertCircle className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--te-warn)' }} />
                ) : active ? (
                  <Spinner size={16} />
                ) : (
                  <Circle className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--te-text-4)' }} />
                )}
                <span className="te-mono w-[22px] flex-shrink-0 text-[12px]">{index + 1}</span>
                <span className="min-w-0 flex-grow truncate">{item.title}</span>
                {(item.status === 'skipped' || item.status === 'failed') && (
                  <span
                    className="max-w-[40%] flex-shrink-0 truncate text-[12px]"
                    style={{ color: 'var(--te-warn-text)' }}
                    title={item.error}
                  >
                    {item.status === 'failed' ? 'Failed' : 'No captions · skipped'}
                  </span>
                )}
              </li>
            );
          })}
        </ol>

        <div className="te-glass flex-shrink-0">
          <SwitchRow
            label="Combined download"
            hint="One file for the whole course when finished"
            checked={batchState.autoDownload}
            onChange={handleAutoDownloadChange}
          />
        </div>

        <div className="mt-auto flex flex-shrink-0 flex-col gap-2">
          <button type="button" onClick={handleCancelBatch} className="te-btn w-full">
            <Square className="h-3.5 w-3.5" strokeWidth={2.2} />
            Stop
          </button>
          <p className="te-muted px-1 text-center text-[12px]">
            You can close this popup — the course keeps extracting in the background.
          </p>
        </div>
      </>
    );
  };

  /** Export settings. */
  const renderSettings = () => (
    <>
      <div className="te-glass flex flex-col gap-2 px-4 py-3.5">
        <label htmlFor="export-format" className="te-kicker">
          Export as
        </label>
        <select
          id="export-format"
          value={exportFormat}
          onChange={(e) => {
            userChoseSettings.current = true;
            setExportFormat(e.target.value as ExportFormat);
          }}
          className="te-select"
        >
          <optgroup label="Reading and AI tools">
            <option value="markdown">Markdown (.md)</option>
            <option value="organized">Organized notes (.md)</option>
            <option value="txt">Plain text (.txt)</option>
            <option value="rag">Retrieval chunks (.json)</option>
          </optgroup>
          <optgroup label="Notes apps">
            <option value="obsidian">Obsidian note (.md)</option>
          </optgroup>
          <optgroup label="Studying">
            <option value="anki">Flashcards for Anki (.csv)</option>
          </optgroup>
          <optgroup label="Subtitles">
            <option value="srt">SubRip (.srt)</option>
            <option value="vtt">WebVTT (.vtt)</option>
          </optgroup>
          <optgroup label="Data">
            <option value="csv">Spreadsheet (.csv)</option>
            <option value="json">JSON (.json)</option>
          </optgroup>
        </select>
        <p className="te-muted text-[12px]">{FORMAT_HINTS[exportFormat]}</p>
      </div>

      <div className="te-glass te-divide flex flex-col">
        <SwitchRow
          label="Timestamps"
          hint="Keep [mm:ss] markers in exported text"
          checked={includeTimestamps}
          onChange={(next) => {
            userChoseSettings.current = true;
            setIncludeTimestamps(next);
          }}
        />
        <SwitchRow
          label="Auto-save transcript exports"
          hint="Save the file when extraction finishes"
          checked={autoDownload}
          onChange={handleAutoDownloadChange}
        />
      </div>

      {hasAnything && (
        <button type="button" onClick={() => setShowSearch(true)} className="te-glass te-row-link">
          <span className="te-badge">
            <Search className="h-[18px] w-[18px]" strokeWidth={1.9} />
          </span>
          <span className="flex min-w-0 flex-grow flex-col">
            <span className="font-semibold">Search this lecture</span>
            <span className="te-muted text-[12px]">Chapters, key concepts, jump to a moment</span>
          </span>
          <ChevronRight className="h-[18px] w-[18px]" style={{ color: 'var(--te-text-4)' }} />
        </button>
      )}

      {hasAnything && <details className="te-glass p-4">
        <summary className="cursor-pointer text-sm">Transcript exports</summary>
        <div className="mt-3 flex flex-col gap-3">
          <button type="button" className="te-btn" disabled={isExporting} onClick={() => void handleExport('download')}>Export current transcript</button>
          {collection.length > 1 && <button type="button" className="te-btn" disabled={isExporting} onClick={() => void handleDownloadAllCombined()}>Export collected transcripts in one file</button>}
        </div>
      </details>}

      <button type="button" onClick={() => setView('main')} className="te-btn-primary mt-4 w-full flex-shrink-0">
        Done
      </button>
    </>
  );

  // The side panel fills the browser height and keeps the download engine mounted.
  const SHELL = 'w-full min-w-[320px] h-screen';

  if (showSearch) {
    return (
      <div className={SHELL}>
        <TranscriptSearch
          lectures={searchableLectures}
          meta={sourceMeta}
          onClose={() => setShowSearch(false)}
        />
      </div>
    );
  }

  return (
    <div className={`te-shell ${SHELL}`}>
      {renderHeader()}
      <main className="te-scroll flex min-h-0 flex-grow flex-col gap-3 overflow-y-auto px-3.5 pb-3.5 pt-2.5">
        {unsaved && (
          <section
            className="te-note te-note--warn flex flex-col gap-2"
            aria-label="Unsaved transcript"
          >
            <p role="status">
              {saving ? 'Saving transcript…' : 'Extracted, but not saved to your library.'}
            </p>
            <button className="te-btn" disabled={saving} onClick={() => void retrySave()}>
              Retry save
            </button>
            <button
              className="te-btn"
              onClick={() =>
                void getExtensionService().then(service =>
                  service.downloadFile(
                    unsaved.transcript,
                    service.generateFilename(unsaved.title, 'txt'),
                    'text/plain'
                  )
                )
              }
            >
              Download recovery copy
            </button>
          </section>
        )}
        {batchState &&
          (!batchState.isActive || batchState.isPaused) &&
          (batchState.error ||
            batchState.items.some(item =>
              ['pending', 'extracting', 'failed'].includes(item.status)
            )) && (
            <section className="te-glass flex flex-col gap-2 p-3" aria-label="Collection recovery">
              <p>{batchState.error || 'Saved collection progress is available.'}</p>
              <p className="te-muted text-xs">
                Open a video in the same course or playlist to continue.
              </p>
              {batchState.items.some(
                item => item.status === 'pending' || item.status === 'extracting'
              ) && (
                <button className="te-btn" onClick={() => void handleResume()}>
                  Resume collection
                </button>
              )}
              {batchState.items.some(item => item.status === 'failed') && (
                <button className="te-btn" onClick={() => void handleResume(true)}>
                  Retry failed items
                </button>
              )}
            </section>
          )}

        {view === 'settings' && <SubscriptionSettings />}
        {view === 'main' && sourceTabId === undefined && (
          <p className="te-muted text-sm">Open a video or course page to start downloading.</p>
        )}
        {sourceTabId !== undefined && (
          <div>
            <VideoDownload
              key={sourceTabId}
              sourceTabId={sourceTabId}
              screen={view}
              onBusyChange={setDownloadBusy}
            />
          </div>
        )}

        {view === 'settings' && renderSettings()}

      </main>
    </div>
  );
};
