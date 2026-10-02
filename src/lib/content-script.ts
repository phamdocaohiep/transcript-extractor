// Content Script for Transcript Extractor Extension - v3.0.0
// This script runs in the context of web pages

// Import extractors - these will be bundled into the content script
import { UdemyExtractor } from './udemy-extractor';
import { YouTubeExtractor } from './youtube-extractor';
import { CourseraExtractor } from './coursera-extractor';
import {
  extractGenericTranscript,
  findPrimaryVideo,
  getGenericVideoInfo,
  hasGenericTranscript,
  isGenericVideoPage,
} from './generic-extractor';
import { installQuickNote } from './quick-note';
import { showPageToast, type ToastTone } from './page-toast';
import {
  type BatchItem,
  type BatchState,
  getBatchState,
  setBatchState,
} from './batch-service';
import { addLecture, lectureId, loadCollection, saveCollection } from './collection';
import { loadCourseCollection, saveCourseLecture } from './collection-store';
import { courseIdFromUrl, courseUrlFromId } from './library-schema';
import { ExtensionService, type ExportFormat } from './extension-service';

// Fallback: if imports fail, create minimal extractors
if (typeof UdemyExtractor === 'undefined') {
  console.error('🎯 UdemyExtractor import failed, creating fallback');
}
if (typeof YouTubeExtractor === 'undefined') {
  console.error('🎯 YouTubeExtractor import failed, creating fallback');
}

// Extend window interface for TypeScript
declare global {
  interface Window {
    transcriptExtractorContentScript?: ContentScript;
    transcriptExtractorPopup?: {
      handleMessage: (message: any) => void;
    };
  }
}

// Message types for communication with popup
export interface ContentScriptMessage {
  type:
    | 'EXTRACT_COURSE_STRUCTURE'
    | 'EXTRACT_TRANSCRIPT'
    | 'GET_VIDEO_INFO'
    | 'CHECK_AVAILABILITY'
    | 'START_BATCH_COLLECTION'
    | 'NAVIGATE_TO_NEXT_LECTURE'
    | 'COLLECT_CURRENT_TRANSCRIPT'
    | 'EXPORT_BATCH_TRANSCRIPTS'
    | 'START_BATCH_EXTRACTION'
    | 'CANCEL_BATCH_EXTRACTION'
    | 'GET_BATCH_STATUS'
    | 'TEST_COURSE_STRUCTURE'
    | 'PREPARE_CAPTURE'
    | 'RESUME_PLAYBACK'
    | 'SEEK_TO'
    | 'SHOW_TOAST';
  data?: any;
}

export interface ContentScriptResponse {
  success: boolean;
  data?: any;
  error?: string;
}

class ContentScript {
  private isInitialized = false;
  private batchState: {
    isActive: boolean;
    lectureIds: string[];
    currentIndex: number;
    collectedTranscripts: {[lectureId: string]: string};
    progress: {[lectureId: string]: 'pending' | 'collecting' | 'completed' | 'failed' | 'skipped'};
  } = {
    isActive: false,
    lectureIds: [],
    currentIndex: 0,
    collectedTranscripts: {},
    progress: {}
  };

  constructor() {
    this.initialize();
  }

  private initialize() {
    try {
      if (this.isInitialized) return;
      
      console.log('🎯 Initializing NEW Content Script v3.0.0...');

      // Alt+Shift+N writes a note against the current moment, without leaving
      // the lecture. Installed unconditionally: the shortcut checks for a video
      // itself, so it costs nothing on a page that has none.
      installQuickNote();
      
      // Listen for messages from popup and background
      chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
        try {
          console.log('🎯 Content script received message:', message);
          
          // Service Worker pattern - no AI message forwarding needed
          // AI summarization is handled directly via ExtensionService.summarizeWithAI()
          
          // Handle other messages (extraction, etc.)
          this.handleMessage(message, sendResponse);
          return true; // Keep message channel open for async response
        } catch (error) {
          console.error('Error handling message:', error);
          sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
          return true;
        }
      });

      this.isInitialized = true;
      console.log('🎯 NEW Transcript Extractor Content Script v3.0.0 initialized on:', window.location.href);
      console.log('🎯 NEW Content script ready to receive messages');
      
      // Override any existing content script
      window.transcriptExtractorContentScript = this;

      // Resume active batch if page reloaded during course extraction
      void getBatchState().then((state) => {
        if (state && state.isActive && !state.isPaused) {
          console.log('🎯 Resuming active batch extraction after page navigation/reload...');
          setTimeout(() => {
            void this.processBatchQueue();
          }, 2000);
        }
      });
    } catch (error) {
      console.error('Error initializing content script:', error);
    }
  }

  private async handleMessage(message: ContentScriptMessage, sendResponse: (response: ContentScriptResponse) => void) {
    try {
      
      switch (message.type) {
        case 'EXTRACT_COURSE_STRUCTURE': {
          const courseStructure = await this.extractCourseStructure();
          sendResponse({ success: true, data: courseStructure });
          break;
        }

        case 'EXTRACT_TRANSCRIPT': {
          const transcript = await this.extractTranscript();
          sendResponse({ success: true, data: transcript });
          break;
        }

        case 'TEST_COURSE_STRUCTURE': {
          UdemyExtractor.testCourseStructureSelectors();
          sendResponse({ success: true, data: 'Course structure testing completed - check console' });
          break;
        }

        case 'GET_VIDEO_INFO': {
          const videoInfo = this.getVideoInfo();
          sendResponse({ success: true, data: videoInfo });
          break;
        }

        case 'PREPARE_CAPTURE': {
          sendResponse({ success: true, data: await this.prepareCapture() });
          break;
        }

        case 'RESUME_PLAYBACK': {
          sendResponse({ success: true, data: this.resumePlayback() });
          break;
        }

        case 'SEEK_TO': {
          sendResponse({ success: true, data: this.seekTo(Number(message.data?.seconds)) });
          break;
        }

        // The background worker has nowhere of its own to speak: a shortcut
        // does not open the popup, so it reports through the page.
        case 'SHOW_TOAST': {
          showPageToast(
            String(message.data?.message ?? ''),
            (message.data?.tone as ToastTone) ?? 'ok',
          );
          sendResponse({ success: true });
          break;
        }

        case 'CHECK_AVAILABILITY': {
          const availability = this.checkAvailability();
          sendResponse({ success: true, data: availability });
          break;
        }

        case 'START_BATCH_EXTRACTION': {
          const result = await this.startBatchExtraction(message.data);
          sendResponse({ success: true, data: result });
          break;
        }

        case 'CANCEL_BATCH_EXTRACTION': {
          await this.cancelBatchExtraction();
          sendResponse({ success: true });
          break;
        }

        case 'GET_BATCH_STATUS': {
          const status = await getBatchState();
          sendResponse({ success: true, data: status });
          break;
        }

        case 'START_BATCH_COLLECTION': {
          await this.startBatchCollection(message.data?.lectureIds || []);
          sendResponse({ success: true });
          break;
        }

        case 'NAVIGATE_TO_NEXT_LECTURE': {
          const navigationResult = await this.navigateToNextLecture();
          sendResponse({ success: true, data: navigationResult });
          break;
        }

        case 'COLLECT_CURRENT_TRANSCRIPT': {
          const collectionResult = await this.collectCurrentTranscript();
          sendResponse({ success: true, data: collectionResult });
          break;
        }

        case 'EXPORT_BATCH_TRANSCRIPTS': {
          const exportResult = await this.exportBatchTranscripts(message.data?.format || 'txt');
          sendResponse({ success: true, data: exportResult });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (error) {
      console.error('Content script error:', error);
      sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  private async extractCourseStructure() {
    if (UdemyExtractor.isUdemyCoursePage()) {
      return UdemyExtractor.extractCourseStructure();
    }
    
    if (YouTubeExtractor.isYouTubeVideoPage()) {
      // Try to extract playlist first
      const playlist = YouTubeExtractor.extractPlaylist();
      if (playlist && playlist.videos.length > 0) {
        
        // Convert playlist to course structure format
        const lectures = playlist.videos.map(video => ({
          id: video.videoId,
          title: video.title,
          url: video.url,
          isCompleted: false,
          duration: video.duration || 'Unknown',
          isCurrentVideo: video.isCurrentVideo
        }));

        // Find current video
        const currentVideo = playlist.videos.find(video => video.isCurrentVideo) || playlist.videos[0];
        
        return {
          title: playlist.title,
          instructor: 'YouTube Creator',
          sections: [{
            title: 'Playlist Videos',
            lectures: lectures
          }],
          currentLecture: {
            id: currentVideo.videoId,
            title: currentVideo.title,
            url: currentVideo.url,
            isCompleted: false,
            duration: currentVideo.duration || 'Unknown'
          }
        };
      }
      
      // Fallback: if no playlist found, return single video structure
      const videoInfo = YouTubeExtractor.getCurrentVideoInfo();
      if (videoInfo) {
        return {
          title: videoInfo.title,
          instructor: 'YouTube Creator',
          sections: [{
            title: 'Video',
            lectures: [{
              id: videoInfo.videoId,
              title: videoInfo.title,
              url: videoInfo.url,
              isCompleted: false,
              duration: 'Unknown'
            }]
          }],
          currentLecture: {
            id: videoInfo.videoId,
            title: videoInfo.title,
            url: videoInfo.url,
            isCompleted: false,
            duration: 'Unknown'
          }
        };
      }
    }
    
    if (CourseraExtractor.isCourseraCoursePage()) {
      return CourseraExtractor.extractCourseStructure();
    }
    
    throw new Error('Unsupported platform');
  }

  private async extractTranscript() {
    
    const isUdemy = UdemyExtractor.isUdemyCoursePage();
    const isYouTube = YouTubeExtractor.isYouTubeVideoPage();
    const isCoursera = CourseraExtractor.isCourseraCoursePage();
    
    if (isUdemy) {
      try {
        const result = await UdemyExtractor.extractTranscript();
        
        // Don't auto-copy to clipboard to prevent popup from closing
        // User can manually export if needed
        
        return result;
      } catch (error) {
        console.error('Udemy extractor error:', error);
        throw error;
      }
    }
    
    if (isYouTube) {
      try {
        const result = await YouTubeExtractor.extractTranscript();
        
        // Don't auto-copy to clipboard to prevent popup from closing
        // User can manually export if needed
        
        return result;
      } catch (error) {
        console.error('YouTube extractor error:', error);
        throw error;
      }
    }
    
    if (isCoursera) {
      try {
        const result = await CourseraExtractor.extractTranscript();
        
        // Don't auto-copy to clipboard to prevent popup from closing
        // User can manually export if needed
        
        return result;
      } catch (error) {
        console.error('Coursera extractor error:', error);
        throw error;
      }
    }
    
    // Not a platform we have a bespoke extractor for. Rather than give up,
    // go after the caption data directly — this is what makes Panopto,
    // Kaltura, Echo360, Moodle and self-hosted players work.
    if (isGenericVideoPage()) {
      return await extractGenericTranscript();
    }

    throw new Error('No video found on this page.');
  }

  /**
   * Pause the lecture, settle, and report where to crop.
   *
   * Capturing a playing video catches whatever frame the compositor happened
   * to be on, which on a screencast is often mid-scroll or mid-transition.
   * Pausing first is also what removes the step the user was doing by hand:
   * the extension popup closes the moment you click the page, so pausing
   * manually meant closing the popup, pausing, and reopening it.
   *
   * `wasPlaying` goes back to the caller so playback can be restored after the
   * capture — taking a screenshot should not decide whether you are watching.
   *
   * The rectangle is reported in CSS pixels with the device pixel ratio
   * alongside, because the captured bitmap is in device pixels and the two
   * differ on most laptops. `findPrimaryVideo` picks the lecture by playback
   * state, duration and size rather than by selector, which is what makes this
   * work on any HTML5 player rather than three named ones.
   *
   * Videos inside a cross-origin iframe are not reachable from here; that
   * would need `all_frames` in the manifest and a per-frame capture path.
   */
  private async prepareCapture() {
    const video = findPrimaryVideo();
    if (!video) return null;

    const wasPlaying = !video.paused;
    if (wasPlaying) {
      video.pause();
      // One or two compositor frames for the paused image to be what is on
      // screen. Without this the capture can still catch the moving frame.
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    const rect = video.getBoundingClientRect();
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      seconds: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      devicePixelRatio: window.devicePixelRatio || 1,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      paused: video.paused,
      wasPlaying,
    };
  }

  /**
   * Put the player on a given moment.
   *
   * This is the way back from the notes to the lecture. Udemy ignores `#t=` in
   * the URL — which is why people scrub the timeline by hand hunting for the
   * line they just read — but a content script holds the `<video>` element
   * itself, where the playhead is simply a property. The same access that
   * pauses for a screenshot seeks for a note.
   *
   * Playback is deliberately not started. Someone who clicks a timestamp while
   * reading may want the surrounding lines first, and a video that starts
   * talking at them is more annoying to undo than pressing play is to do.
   *
   * Seeking past the end leaves the player on a black frame, so the moment is
   * clamped — but only when the duration is known. A tab that has just opened
   * reports `NaN`, and clamping against that would seek to nowhere.
   */
  private seekTo(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return { seeked: false, reason: 'Not a valid moment.' };
    }

    const video = findPrimaryVideo();
    if (!video) return { seeked: false, reason: 'No video found on this page.' };

    const duration = video.duration;
    video.currentTime = Number.isFinite(duration)
      ? Math.min(seconds, Math.max(duration - 0.5, 0))
      : seconds;

    return { seeked: true, seconds: video.currentTime };
  }

  /** Resume a lecture this extension paused to take a still. */
  private resumePlayback() {
    const video = findPrimaryVideo();
    if (!video) return false;
    // A rejected play() is not worth surfacing: the frame is already captured,
    // and the user can press play themselves.
    void video.play().catch(() => undefined);
    return true;
  }

  private getVideoInfo() {
    if (UdemyExtractor.isUdemyCoursePage()) {
      return UdemyExtractor.getCurrentVideoInfo();
    }
    
    if (YouTubeExtractor.isYouTubeVideoPage()) {
      return YouTubeExtractor.getCurrentVideoInfo();
    }
    
    if (CourseraExtractor.isCourseraCoursePage()) {
      return CourseraExtractor.getCurrentVideoInfo();
    }
    
    return getGenericVideoInfo();
  }

  private checkAvailability() {
    
    const isUdemy = UdemyExtractor.isUdemyCoursePage();
    
    if (isUdemy) {
      return {
        platform: 'udemy',
        hasTranscript: UdemyExtractor.isTranscriptAvailable(),
        isCoursePage: true
      };
    }
    
    const isYouTube = YouTubeExtractor.isYouTubeVideoPage();
    
    if (isYouTube) {
      return {
        platform: 'youtube',
        hasTranscript: YouTubeExtractor.isTranscriptAvailable(),
        isCoursePage: true
      };
    }
    
    const isCoursera = CourseraExtractor.isCourseraCoursePage();
    
    if (isCoursera) {
      return {
        platform: 'coursera',
        hasTranscript: CourseraExtractor.isTranscriptAvailable(),
        isCoursePage: true
      };
    }
    
    if (isGenericVideoPage()) {
      return {
        platform: 'generic',
        hasTranscript: hasGenericTranscript(),
        isCoursePage: true
      };
    }
    
    return {
      platform: 'unknown',
      hasTranscript: false,
      isCoursePage: false
    };
  }

  // Batch collection methods
  private isProcessingBatch = false;

  /**
   * Start extracting an entire course in automated batch mode
   */
  private async startBatchExtraction(options?: {
    autoDownload?: boolean;
    exportFormat?: ExportFormat;
  }): Promise<BatchState | null> {
    console.log('🎯 Starting full course batch extraction...');

    // 1. Expand all sections if on Udemy
    if (UdemyExtractor.isUdemyCoursePage()) {
      await UdemyExtractor.expandAllSections();
    }

    // 2. Extract curriculum structure
    const structure = await this.extractCourseStructure();
    const items: BatchItem[] = [];

    if (structure && Array.isArray(structure.sections)) {
      for (const section of structure.sections) {
        if (Array.isArray(section.lectures)) {
          for (const lecture of section.lectures) {
            items.push({
              id: lecture.id,
              title: lecture.title,
              url: lecture.url,
              duration: lecture.duration,
              status: 'pending',
            });
          }
        }
      }
    }

    if (items.length === 0) {
      showPageToast('Could not find lectures in course structure', 'warn');
      return null;
    }

    const state: BatchState = {
      isActive: true,
      isPaused: false,
      courseTitle: structure?.title || document.title || 'Course Transcript',
      courseUrl: window.location.href,
      items,
      currentIndex: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      autoDownload: options?.autoDownload ?? false,
      exportFormat: options?.exportFormat || 'markdown',
    };

    await setBatchState(state);
    showPageToast(`🚀 Starting entire course extraction (${items.length} lectures)`, 'ok');

    // Trigger processing loop asynchronously
    void this.processBatchQueue();

    return state;
  }

  /**
   * Cancel an in-progress batch extraction
   */
  private async cancelBatchExtraction(): Promise<void> {
    console.log('🎯 Cancelling batch extraction...');
    const state = await getBatchState();
    if (state) {
      state.isActive = false;
      state.isPaused = false;
      state.updatedAt = Date.now();
      await setBatchState(state);
    }
    showPageToast('Batch extraction stopped', 'warn');
  }

  /**
   * Main sequential loop for processing batch extraction queue
   */
  private async processBatchQueue(): Promise<void> {
    if (this.isProcessingBatch) return;
    this.isProcessingBatch = true;

    try {
      while (true) {
        const state = await getBatchState();
        if (!state || !state.isActive || state.isPaused) {
          break;
        }

        if (state.currentIndex >= state.items.length) {
          // Completed all items in course
          state.isActive = false;
          state.updatedAt = Date.now();
          await setBatchState(state);

          const completedCount = state.items.filter((i) => i.status === 'completed').length;
          const skippedCount = state.items.filter((i) => i.status === 'skipped').length;
          const failedCount = state.items.filter((i) => i.status === 'failed').length;
          const summaryMsg = skippedCount > 0 || failedCount > 0
            ? `Course extracted: ${completedCount}/${state.items.length} captured (${skippedCount} skipped, ${failedCount} failed)`
            : `🎉 Course extracted! (${completedCount}/${state.items.length} lectures captured)`;
          showPageToast(summaryMsg, completedCount > 0 ? 'ok' : 'warn');

          if (state.autoDownload) {
            await this.triggerFullCourseDownload(state);
          }
          break;
        }

        const item = state.items[state.currentIndex];
        item.status = 'extracting';
        state.updatedAt = Date.now();
        await setBatchState(state);

        showPageToast(
          `Extracting ${state.currentIndex + 1}/${state.items.length}: ${item.title.substring(0, 32)}…`,
          'ok'
        );

        // Check if we are already on this lecture
        const currentLectureId = this.getCurrentLectureId();
        const isAlreadyOnLecture =
          item.id && item.id !== 'unknown' && !item.id.startsWith('lecture-')
            ? currentLectureId === item.id
            : item.url
              ? window.location.href.split('?')[0] === item.url.split('?')[0]
              : false;

        if (!isAlreadyOnLecture) {
          console.log(`🎯 Navigating to lecture: ${item.title} (ID: ${item.id})`);
          await this.navigateToBatchItem(item);
        }

        // Wait for video/content to settle after navigation
        await this.waitForLectureReady(2500);

        // Check if user cancelled while waiting
        const currentState = await getBatchState();
        if (!currentState || !currentState.isActive) break;

        // Fast-path detection: If this lecture is clearly an article, handout, or quiz with no video, skip immediately
        const immediateVideo = document.querySelector('video') || document.querySelector('[data-purpose*="video"]');
        const immediateArticle = document.querySelector(
          '[data-purpose="article-viewer"], [data-purpose="resource-viewer"], [class*="resource-list"], [class*="article-asset"], [class*="article-viewer"], [data-purpose="quiz-pane"], [data-purpose="practice-test"], .quiz--container--37Y10'
        );

        let transcript: string | null = null;
        let lastError: string | null = null;

        if (!immediateVideo && immediateArticle) {
          console.log(`🎯 Immediately detected non-video lecture (article/resource): ${item.title}`);
          item.status = 'skipped';
          item.error = 'Article or reading handout (no video)';
          showPageToast(`⏭️ Skipped "${item.title.substring(0, 26)}…": Article (no video)`, 'warn');
        } else {
          // Try extracting with up to 3 attempts for video lectures
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              console.log(`🎯 Extraction attempt ${attempt + 1} for ${item.title}...`);
              transcript = await this.extractTranscript();
              if (transcript && transcript.trim().length > 0) {
                break;
              }
            } catch (err) {
              lastError = err instanceof Error ? err.message : String(err);
              console.warn(`Extraction attempt ${attempt + 1} failed:`, err);
            }

            // If no video was found after extraction attempt and the page is clearly an article/quiz, break retry
            const hasVideo = !!document.querySelector('video') || !!document.querySelector('[data-purpose*="video"]');
            const isArticle = !!document.querySelector(
              '[data-purpose="article-viewer"], [data-purpose="resource-viewer"], [class*="resource-list"], [class*="article-asset"], [class*="article-viewer"], [data-purpose="quiz-pane"], [data-purpose="practice-test"], .quiz--container--37Y10'
            );
            if (isArticle && !hasVideo) {
              console.log(`🎯 Confirmed non-video item (quiz/article): ${item.title}`);
              break;
            }

            await new Promise((resolve) => setTimeout(resolve, 800));
          }

          if (transcript && transcript.trim().length > 0) {
            item.status = 'completed';
            item.wordCount = transcript.trim().split(/\s+/).length;
            console.log(`🎯 Extraction SUCCESS for ${item.title} (${item.wordCount} words)`);
            await this.persistBatchLecture(item, transcript, state.courseTitle);
          } else {
            const hasVideo = !!document.querySelector('video') || !!document.querySelector('[data-purpose*="video"]');
            const isArticle = !!document.querySelector(
              '[data-purpose="article-viewer"], [data-purpose="resource-viewer"], [class*="resource-list"], [class*="article-asset"], [class*="article-viewer"], [data-purpose="quiz-pane"], [data-purpose="practice-test"], .quiz--container--37Y10'
            );

            item.status = 'skipped';
            if (isArticle && !hasVideo) {
              item.error = 'Article or reading handout (no video)';
              showPageToast(`⏭️ Skipped "${item.title.substring(0, 26)}…": Article (no video)`, 'warn');
            } else if (lastError?.includes('Video not ready') || lastError?.includes('timeout')) {
              item.error = 'Video player loading timeout';
              showPageToast(`⏭️ Skipped "${item.title.substring(0, 26)}…": Video took too long to load`, 'warn');
            } else {
              item.error = 'No captions or transcript available on Udemy';
              showPageToast(`⏭️ Skipped "${item.title.substring(0, 26)}…": No captions on Udemy`, 'warn');
            }
            console.log(`🎯 Skipping lecture ${item.title}: ${item.error}`);
          }
        }

        // Advance index
        currentState.items[currentState.currentIndex] = item;
        currentState.currentIndex++;
        currentState.updatedAt = Date.now();
        await setBatchState(currentState);

        // Polite delay between lectures to prevent UI lag and rate limiting
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    } catch (e) {
      console.error('Error in batch queue processing:', e);
    } finally {
      this.isProcessingBatch = false;
    }
  }

  /**
   * Navigate to a specific batch item in the course
   */
  private async navigateToBatchItem(item: BatchItem): Promise<boolean> {
    try {
      // Find curriculum container to scope search and prevent clicking links in the article content
      const getCurriculumContainer = () =>
        document.querySelector(
          '[data-purpose="course-curriculum"], aside, nav[aria-label*="curriculum" i], .curriculum-navigation, [class*="curriculum-navigation"]'
        ) || document;

      let sidebar = getCurriculumContainer();

      // 1. Try finding lecture link or button in curriculum sidebar
      let targetEl: HTMLElement | null = null;
      if (item.id && !item.id.startsWith('lecture-')) {
        targetEl =
          sidebar.querySelector(`[data-purpose="curriculum-item-${item.id}"]`) ||
          sidebar.querySelector(`[data-purpose*="${item.id}"]`) ||
          sidebar.querySelector(`a[href*="/learn/lecture/${item.id}"]`);
      }

      const normalizeTitle = (s: string) =>
        s.toLowerCase().replace(/^\d+[\s.-]+/, '').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

      // If not found by ID, try matching item by title strictly within sidebar
      if (!targetEl && item.title) {
        const itemNorm = normalizeTitle(item.title);
        const candidates = sidebar.querySelectorAll(
          '[data-purpose^="curriculum-item-"], .curriculum-item-link, [data-purpose="item-title"]'
        );
        for (const cand of candidates) {
          const text = cand.textContent || '';
          const candNorm = normalizeTitle(text);
          if (
            candNorm.length >= 4 &&
            (candNorm === itemNorm ||
              (candNorm.length >= 8 && itemNorm.length >= 8 && (candNorm.startsWith(itemNorm) || itemNorm.startsWith(candNorm))))
          ) {
            targetEl =
              (cand.closest('[data-purpose^="curriculum-item-"], .curriculum-item-link') as HTMLElement) ||
              (cand as HTMLElement);
            break;
          }
        }
      }

      // If not found, collapsed sections in Udemy might hide the item
      if (!targetEl && UdemyExtractor.isUdemyCoursePage()) {
        await UdemyExtractor.expandAllSections();
        await new Promise((r) => setTimeout(r, 200));
        sidebar = getCurriculumContainer();

        if (item.id && !item.id.startsWith('lecture-')) {
          targetEl =
            sidebar.querySelector(`[data-purpose="curriculum-item-${item.id}"]`) ||
            sidebar.querySelector(`[data-purpose*="${item.id}"]`) ||
            sidebar.querySelector(`a[href*="/learn/lecture/${item.id}"]`);
        }
        if (!targetEl && item.title) {
          const itemNorm = normalizeTitle(item.title);
          const candidates = sidebar.querySelectorAll(
            '[data-purpose^="curriculum-item-"], .curriculum-item-link, [data-purpose="item-title"]'
          );
          for (const cand of candidates) {
            const text = cand.textContent || '';
            const candNorm = normalizeTitle(text);
            if (
              candNorm.length >= 4 &&
              (candNorm === itemNorm ||
                (candNorm.length >= 8 && itemNorm.length >= 8 && (candNorm.startsWith(itemNorm) || itemNorm.startsWith(candNorm))))
            ) {
              targetEl =
                (cand.closest('[data-purpose^="curriculum-item-"], .curriculum-item-link') as HTMLElement) ||
                (cand as HTMLElement);
              break;
            }
          }
        }
      }

      if (targetEl) {
        // Expand parent section accordion if collapsed
        const parentSection = targetEl.closest('[data-purpose^="section-panel-"], .ud-accordion-panel');
        const toggler = parentSection?.querySelector(
          'button[aria-expanded="false"], .ud-accordion-panel-toggler[aria-expanded="false"]'
        ) as HTMLElement | null;
        if (toggler) {
          toggler.click();
          await new Promise((r) => setTimeout(r, 250));
        }

        targetEl.scrollIntoView({ block: 'center', behavior: 'instant' });

        // Accurately target the lecture navigation link; NEVER click resources or checkboxes
        const navLink =
          (targetEl.matches('a[href*="/learn/lecture/"]') ? targetEl : null) ||
          targetEl.querySelector<HTMLElement>('a[href*="/learn/lecture/"]') ||
          targetEl.querySelector<HTMLElement>('[data-purpose="item-title"], .curriculum-item-link--item-title--3Qj8Y') ||
          targetEl.querySelector<HTMLElement>(
            'button:not([role="checkbox"]):not([data-purpose*="complete"]):not([aria-label*="complete" i]):not([data-purpose*="resource"]):not([aria-label*="resource" i])'
          ) ||
          targetEl;

        // Prevent opening new tabs: ensure target is _self and verify URL
        let canClick = true;
        if (navLink instanceof HTMLAnchorElement) {
          const href = navLink.getAttribute('href') || '';
          if (!href.includes('/learn/lecture/') && !href.startsWith('#')) {
            console.warn('Blocked clicking non-lecture anchor:', href);
            canClick = false;
          } else {
            navLink.target = '_self';
          }
        }

        if (canClick) {
          navLink.click();
          // DO NOT dispatch a secondary MouseEvent('click') here: that causes double-clicking and opens 2 tabs!
          await this.waitForLectureChange(3000);

          const currentLectureId = this.getCurrentLectureId();
          const navSucceeded =
            item.id && !item.id.startsWith('lecture-')
              ? currentLectureId === item.id
              : window.location.href.split('?')[0] === item.url?.split('?')[0];

          if (navSucceeded) {
            return true;
          }
        }
      }

      // 2. Direct URL navigation fallback
      let directUrl = item.url;
      if (!directUrl && item.id && !item.id.startsWith('lecture-')) {
        const slugMatch = window.location.pathname.match(/\/course\/([^/]+)/);
        if (slugMatch) {
          directUrl = `${window.location.origin}/course/${slugMatch[1]}/learn/lecture/${item.id}`;
        }
      }

      if (directUrl && window.location.href.split('?')[0] !== directUrl.split('?')[0]) {
        console.log(`🎯 Direct navigation fallback to URL: ${directUrl}`);
        window.location.href = directUrl;
        await this.waitForLectureChange(5000);
        return true;
      }

      return false;
    } catch (err) {
      console.warn('Navigation error:', err);
      return false;
    }
  }

  /**
   * Settle after navigation: gives player or article DOM elements time to mount
   */
  private async waitForLectureReady(timeout: number = 2500): Promise<void> {
    const start = Date.now();
    // Allow brief delay for previous lecture DOM to unmount and new lecture DOM to mount
    await new Promise((r) => setTimeout(r, 400));
    while (Date.now() - start < timeout) {
      const video = document.querySelector('video');
      const hasCues = document.querySelector('[data-purpose="transcript-cue"]');
      const hasTranscriptBtn = document.querySelector(
        'button[data-purpose="transcript-toggle"], [data-purpose="transcript-toggle"]'
      );
      if (video || hasCues || hasTranscriptBtn) {
        // Found video/transcript elements, let player finish initial rendering
        await new Promise((r) => setTimeout(r, 300));
        return;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  /**
   * Save extracted batch lecture to both collection and library stores
   */
  private async persistBatchLecture(
    item: BatchItem,
    transcript: string,
    courseTitle: string
  ): Promise<void> {
    try {
      const url = item.url || window.location.href;
      const id = lectureId(url, item.title);
      const collected = {
        id,
        title: item.title,
        url,
        transcript,
        collectedAt: Date.now(),
      };

      const courseId = courseIdFromUrl(url);
      const canonicalCourseUrl = courseUrlFromId(courseId) || url;

      // 1. Save to chrome.storage.local collection
      const currentCollection = await loadCollection(canonicalCourseUrl);
      const nextCollection = addLecture(currentCollection, collected);
      await saveCollection(canonicalCourseUrl, nextCollection);
      if (url !== canonicalCourseUrl) {
        await saveCollection(url, nextCollection);
      }

      // 2. Save into IndexedDB library (both in local context and via background service worker)
      await saveCourseLecture(collected, nextCollection, canonicalCourseUrl, {
        courseTitle,
      });

      try {
        await chrome.runtime.sendMessage({
          type: 'SAVE_LECTURE_TO_LIBRARY',
          data: {
            lecture: collected,
            meta: { courseTitle },
          },
        });
      } catch (msgErr) {
        console.warn('Background library sync warning:', msgErr);
      }

      console.log(`🎯 Successfully saved batch lecture: ${item.title} (${nextCollection.length} in collection)`);
    } catch (e) {
      console.error('Failed to persist batch lecture:', e);
    }
  }

  /**
   * Format and download the complete course export bundle
   */
  private async triggerFullCourseDownload(state: BatchState): Promise<void> {
    try {
      const courseId = courseIdFromUrl(state.courseUrl);
      const canonicalCourseUrl = courseUrlFromId(courseId) || state.courseUrl;

      let collection = await loadCollection(canonicalCourseUrl);
      if (collection.length === 0 && state.courseUrl !== canonicalCourseUrl) {
        collection = await loadCollection(state.courseUrl);
      }
      if (collection.length === 0) {
        collection = await loadCourseCollection(canonicalCourseUrl, {
          courseTitle: state.courseTitle,
        });
      }

      if (collection.length === 0) {
        console.warn('No collected lectures to download');
        const completedCount = state.items.filter((i) => i.status === 'completed').length;
        showPageToast(
          `No transcripts collected to download (${completedCount} completed, ${state.items.length - completedCount} skipped)`,
          'warn'
        );
        return;
      }

      const filename = ExtensionService.generateCombinedSegmentsFilename(
        collection,
        state.exportFormat,
        state.courseTitle || 'full_course_transcript'
      );

      const formatted = ExtensionService.formatCollection(
        collection,
        state.exportFormat,
        true,
        {
          url: canonicalCourseUrl,
          platform: 'udemy',
          courseTitle: state.courseTitle,
        }
      );

      const mimeType = ExtensionService.getMimeType(state.exportFormat);
      ExtensionService.downloadFile(formatted, filename, mimeType);
      showPageToast(`📥 Downloaded ${collection.length} lectures (${filename})!`, 'ok');
    } catch (e) {
      console.error('Failed to trigger full course download:', e);
    }
  }

  private async startBatchCollection(lectureIds: string[]) {
    console.log('🎯 Starting batch collection for', lectureIds.length, 'lectures');
    
    this.batchState = {
      isActive: true,
      lectureIds: [...lectureIds],
      currentIndex: 0,
      collectedTranscripts: {},
      progress: {}
    };
    
    // Initialize progress for all lectures
    lectureIds.forEach(id => {
      this.batchState.progress[id] = 'pending';
    });
    
    console.log('🎯 Batch collection initialized:', this.batchState);
  }

  private async navigateToNextLecture(): Promise<boolean> {
    try {
      console.log('🎯 Attempting to navigate to next lecture using Udemy\'s Next button...');
      
      // Find Udemy's built-in "Next" button using multiple approaches
      let nextButton: Element | null = null;
      
      // Approach 1: Try specific selectors
      const selectors = [
        '[data-purpose="go-to-next"]',
        '#go-to-next-item',
        '.next-and-previous--next--8Avih',
        '.next-and-previous--button---fNLz.next-and-previous--next--8Avih'
      ];
      
      for (const selector of selectors) {
        const button = document.querySelector(selector);
        if (button && (button as HTMLElement).offsetParent !== null) { // visible check
          nextButton = button;
          console.log('🎯 Found Next button with selector:', selector);
          break;
        }
      }
      
      // Approach 2: If not found, look for buttons with "next" text or aria-label
      if (!nextButton) {
        const allButtons = document.querySelectorAll('button, [role="button"], .ud-btn');
        for (const button of allButtons) {
          const ariaLabel = button.getAttribute('aria-label')?.toLowerCase() || '';
          const textContent = button.textContent?.toLowerCase() || '';
          
          if ((ariaLabel.includes('next') || textContent.includes('next')) && 
              (button as HTMLElement).offsetParent !== null) { // visible check
            nextButton = button;
            console.log('🎯 Found Next button by text/aria-label:', button);
            break;
          }
        }
      }
      
      if (!nextButton) {
        console.log('🎯 No Udemy Next button found');
        return false;
      }

      console.log('🎯 Found Udemy Next button:', nextButton);
      
      // Check if the button is enabled (not disabled)
      const isDisabled = nextButton.hasAttribute('disabled') || 
                        nextButton.classList.contains('disabled') ||
                        nextButton.getAttribute('aria-disabled') === 'true';
      
      if (isDisabled) {
        console.log('🎯 Next button is disabled - reached end of course');
        return false;
      }

      // Store initial state
      const initialUrl = window.location.href;
      const initialLectureId = this.getCurrentLectureId();
      
      // Click the Next button with minimal interference to prevent popup closing
      console.log('🎯 Clicking Next button...');
      
      // Method 1: Direct click (most reliable)
      (nextButton as HTMLElement).click();
      
      // Method 2: Dispatch click event (backup for SPAs)
      nextButton.dispatchEvent(new MouseEvent('click', {
        view: window,
        bubbles: true,
        cancelable: true
      }));
      
      // Give a moment for the click to register (minimal delay)
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Wait for navigation to complete with dynamic timing
      await this.waitForLectureChange(3000); // Reduced timeout with faster detection
      
      // Verify that navigation actually happened
      const finalUrl = window.location.href;
      const finalLectureId = this.getCurrentLectureId();
      
      if (finalUrl === initialUrl && finalLectureId === initialLectureId) {
        console.log('🎯 Navigation failed - URL and lecture ID unchanged');
        return false;
      }
      
      console.log('🎯 Navigation completed successfully using Udemy Next button');
      console.log('🎯 URL changed from:', initialUrl, 'to:', finalUrl);
      console.log('🎯 Lecture ID changed from:', initialLectureId, 'to:', finalLectureId);
      return true;
    } catch (error) {
      console.error('🎯 Failed to navigate to next lecture:', error);
      return false;
    }
  }

  private async waitForLectureChange(timeout = 10000): Promise<void> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const initialUrl = window.location.href;
      const initialLectureId = this.getCurrentLectureId();
      
      console.log('🎯 Waiting for lecture change. Initial URL:', initialUrl, 'Initial lecture ID:', initialLectureId);
      
      const checkForChange = () => {
        const currentUrl = window.location.href;
        const currentLectureId = this.getCurrentLectureId();
        
        // Check if URL changed (most reliable for SPA navigation)
        if (currentUrl !== initialUrl) {
          console.log('🎯 URL change detected:', currentUrl);
          resolve();
          return;
        }
        
        // Check if lecture ID changed (backup method)
        if (currentLectureId !== initialLectureId && currentLectureId !== 'unknown') {
          console.log('🎯 Lecture ID change detected:', initialLectureId, '->', currentLectureId);
          resolve();
          return;
        }
        
        if (Date.now() - startTime > timeout) {
          console.log('🎯 Timeout waiting for lecture change. Current URL:', currentUrl, 'Current lecture ID:', currentLectureId);
          resolve();
          return;
        }
        
        setTimeout(checkForChange, 100); // Reduced from 200ms to 100ms for faster detection
      };
      
      checkForChange();
    });
  }

  private async collectCurrentTranscript(): Promise<{lectureId: string; transcript: string}> {
    try {
      // Get current lecture ID from URL
      const lectureId = this.getCurrentLectureId();
      console.log('🎯 Collecting transcript for lecture:', lectureId);
      
      // Memory management check for batch processing
      if (this.batchState.isActive) {
        // Add delay between batch operations to prevent memory buildup
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log('🧹 ContentScript: Added delay for batch processing memory management');
      }
      
      // Quick check if page is ready for collection
      const isPageReady = UdemyExtractor.isPageReadyForCollection();
      console.log('🎯 Page ready for collection:', isPageReady);
      
      // Check if transcript is available first
      const isAvailable = await UdemyExtractor.isTranscriptAvailable();
      console.log('🎯 Transcript availability check result:', isAvailable);
      
      if (!isAvailable) {
        console.log('🎯 No transcript available for lecture:', lectureId, '- Skipping');
        // Store as skipped
        this.batchState.collectedTranscripts[lectureId] = 'NO_TRANSCRIPT_AVAILABLE';
        this.batchState.progress[lectureId] = 'skipped';
        
        return { lectureId, transcript: 'NO_TRANSCRIPT_AVAILABLE' };
      }
      
      console.log('🎯 Transcript is available, proceeding with extraction...');
      
      // Extract transcript
      let transcript = await this.extractTranscript();
      console.log('🎯 Extract transcript result:', transcript ? `Length: ${transcript.length} chars` : 'null/empty');
      
      if (transcript && transcript.trim().length > 0) {
        console.log('🎯 Transcript extracted successfully, length:', transcript.length);
        console.log('🎯 First 200 chars of transcript:', transcript.substring(0, 200));
        
        // Memory optimization for batch processing
        if (this.batchState.isActive && transcript.length > 30000) {
          console.log('🧹 ContentScript: Large transcript detected, optimizing for batch processing...');
          // Truncate very long transcripts to prevent memory issues
          transcript = transcript.substring(0, 30000) + '... [truncated for batch processing]';
        }
        
        // Store in batch state
        this.batchState.collectedTranscripts[lectureId] = transcript;
        this.batchState.progress[lectureId] = 'completed';
        
        // Note: Clipboard copying is now handled by the popup to prevent conflicts
        console.log('🎯 Transcript collected successfully - clipboard will be handled by popup');
        
        console.log('🎯 Successfully collected transcript for lecture:', lectureId);
        return { lectureId, transcript };
      } else {
        console.log('🎯 No transcript extracted or transcript is empty');
        throw new Error('No transcript extracted or transcript is empty');
      }
    } catch (error) {
      const lectureId = this.getCurrentLectureId();
      console.error('🎯 Failed to collect transcript:', error instanceof Error ? error.message : String(error));
      
      // Store as failed
      this.batchState.collectedTranscripts[lectureId] = 'EXTRACTION_FAILED';
      this.batchState.progress[lectureId] = 'failed';
      
      return { lectureId, transcript: 'EXTRACTION_FAILED' };
    }
  }

  private async copyToClipboard(text: string): Promise<boolean> {
    try {
      console.log('🎯 Copying to clipboard, text length:', text.length);
      
      // Method 1: Modern Clipboard API (try without clearing first)
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(text);
          console.log('🎯 Successfully copied to clipboard using modern API');
          return true;
        } catch (error) {
          console.log('🎯 Modern clipboard API failed:', error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      console.log('🎯 Modern clipboard API failed, trying fallback...');
    }

    try {
      // Method 2: Legacy execCommand with improved focus handling
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;z-index:9999;pointer-events:none;';
      document.body.appendChild(textarea);
      
      // Try to focus the document first
      if (document.hasFocus && !document.hasFocus()) {
        window.focus();
      }
      
      // Focus the textarea and select text
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      
      // Try to copy
      const success = document.execCommand('copy');
      
      // Clean up
      document.body.removeChild(textarea);
      
      if (success) {
        console.log('🎯 Fallback clipboard copy successful');
        return true;
      } else {
        console.log('🎯 Fallback clipboard copy failed');
        return false;
      }
    } catch (error) {
      console.error('🎯 All clipboard methods failed:', error);
      return false;
    }
  }

  private getCurrentLectureId(): string {
    // Extract lecture ID from URL
    const match = window.location.pathname.match(/\/learn\/lecture\/(\d+)/);
    return match ? match[1] : 'unknown';
  }

  private async exportBatchTranscripts(format: 'markdown' | 'txt' | 'json'): Promise<string> {
    const transcripts = Object.entries(this.batchState.collectedTranscripts);
    
    if (transcripts.length === 0) {
      return 'No transcripts collected';
    }

    switch (format) {
      case 'markdown':
        return this.formatBatchAsMarkdown(transcripts);
      case 'json':
        return this.formatBatchAsJSON(transcripts);
      case 'txt':
      default:
        return this.formatBatchAsText(transcripts);
    }
  }

  private formatBatchAsMarkdown(transcripts: [string, string][]): string {
    let markdown = '# Batch Transcript Collection\n\n';
    markdown += `**Collected:** ${transcripts.length} transcripts\n`;
    markdown += `**Date:** ${new Date().toISOString().slice(0, 10)}\n\n`;
    
    transcripts.forEach(([lectureId, transcript]) => {
      markdown += `## Lecture ${lectureId}\n\n`;
      markdown += transcript.split('\n\n').map(line => `- ${line}`).join('\n');
      markdown += '\n\n---\n\n';
    });
    
    return markdown;
  }

  private formatBatchAsJSON(transcripts: [string, string][]): string {
    const data = {
      metadata: {
        collected: transcripts.length,
        date: new Date().toISOString(),
        format: 'json'
      },
      transcripts: transcripts.map(([lectureId, transcript]) => ({
        lectureId,
        transcript: transcript.split('\n\n').map(line => {
          const match = line.match(/^\[([^\]]+)\]\s*(.+)$/);
          return match ? { timestamp: match[1], text: match[2] } : { text: line };
        })
      }))
    };
    
    return JSON.stringify(data, null, 2);
  }

  private formatBatchAsText(transcripts: [string, string][]): string {
    let text = `BATCH TRANSCRIPT COLLECTION\n`;
    text += `Collected: ${transcripts.length} transcripts\n`;
    text += `Date: ${new Date().toISOString().slice(0, 10)}\n\n`;
    
    transcripts.forEach(([lectureId, transcript]) => {
      text += `=== LECTURE ${lectureId} ===\n\n`;
      text += transcript;
      text += '\n\n---\n\n';
    });
    
    return text;
  }
}

// Prevent duplicate initialization
if (!window.transcriptExtractorContentScript) {
  console.log('🎯 Initializing NEW Content Script v3.0.0...');
  try {
    new ContentScript();
    console.log('🎯 Content Script initialization completed successfully');
  } catch (error) {
    console.error('🎯 Error during Content Script initialization:', error);
  }
} else {
  console.log('🎯 Content Script already initialized, skipping...');
}