import { log } from './log';
// Udemy Transcript Extractor
// Based on the provided HTML structure from Udemy course pages

import { ESTIMATED_TIMING_MARKER, estimateCueTimings, orderCollectedCues } from './transcript';

export interface UdemySection {
  id: string;
  title: string;
  duration: string;
  lectures: UdemyLecture[];
}

export interface UdemyLecture {
  id: string;
  title: string;
  duration: string;
  isCurrent: boolean;
  url?: string;
  transcript?: string;
  kind?: 'video' | 'quiz' | 'article';
}

export interface UdemyCourse {
  title: string;
  instructor: string;
  sections: UdemySection[];
  currentLecture?: UdemyLecture;
}

const SELECTORS = {
  // Most reliable selectors based on testing
  TRANSCRIPT_PANEL: '[data-purpose="transcript-panel"]',
  TRANSCRIPT_ENTRIES: '[data-purpose="transcript-cue"]',
  TRANSCRIPT_BUTTON: 'button[data-purpose="transcript-toggle"]',
  
  // Video element for text tracks
  VIDEO: 'video',
  
  // Course structure selectors - Updated based on actual HTML structure
  COURSE_TITLE: '[data-purpose="course-header-title"], #course-header-title, .course-header-title, [class*="course-header-title"], h1[data-purpose="course-title"]',
  LECTURE_TITLE: '[data-purpose="lecture-title"]',
  SECTION_TITLE: '[data-purpose="section-title"], [class*="section--section-title"], .ud-accordion-panel-title, h3, h2, [role="heading"]',
  SIDEBAR_SECTIONS: '[data-purpose^="section-panel-"]',
  SIDEBAR_LECTURES: '[data-purpose^="curriculum-item-"]',
  LECTURE_ITEM_TITLE: '[data-purpose="item-title"]'
} as const;

export class UdemyExtractor {
  // Simple cleanup tracking for intervals
  private static cleanupIntervals: ReturnType<typeof setInterval>[] = [];

  /**
   * Cleanup all intervals to prevent memory leaks
   */
  static cleanup() {
    this.cleanupIntervals.forEach(interval => clearInterval(interval));
    this.cleanupIntervals = [];
  }

  /**
   * Expand all collapsed accordion sections in the curriculum sidebar
   * so that all lectures are rendered in the DOM for extraction.
   */
  static async expandAllSections(signal?: AbortSignal): Promise<void> {
    try {
      signal?.throwIfAborted();
      const collapsedTogglers = [...document.querySelectorAll<HTMLElement>('[aria-expanded="false"]')]
        .filter(element => !element.closest('[data-purpose^="curriculum-item"], [class*="curriculum-item-link"]') &&
          (element.matches('.ud-accordion-panel-toggler, [data-purpose^="section-panel"]') ||
          element.closest('[data-purpose^="section-panel"], [data-purpose="curriculum-section"], .ud-accordion-panel, [class*="section--panel"], [class*="section--section"], [class*="accordion-panel"]')));
      if (collapsedTogglers.length === 0) return;

      log.debug(`🎯 Expanding ${collapsedTogglers.length} collapsed sections...`);
      for (const btn of collapsedTogglers) {
        signal?.throwIfAborted();
        if (btn.getAttribute('aria-expanded') !== 'false') continue;
        (btn as HTMLElement).click();
        await new Promise((r) => setTimeout(r, 60));
      }
      // Give sufficient time for the DOM to render the expanded lectures
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn('Failed to expand some accordion sections:', e);
    }
  }

  /** Wait for the sidebar to mount, including pages opened in a background tab. */
  static async loadAllItems(signal: AbortSignal): Promise<void> {
    for (let attempt = 0; attempt < 24; attempt++) {
      signal.throwIfAborted();
      await this.expandAllSections(signal);
      if (this.extractSections().some(section => section.lectures.length)) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    signal.throwIfAborted();
  }

  /**
   * Extract course structure from Udemy page
   */
  static extractCourseStructure(): UdemyCourse | null {
    try {
      const courseTitle = this.getCourseTitle();
      const instructor = this.getInstructorName();
      const sections = this.extractSections();
      const currentLecture = this.getCurrentLecture();

      return {
        title: courseTitle,
        instructor: instructor,
        sections: sections,
        currentLecture: currentLecture
      };
    } catch (error) {
      console.error('Error extracting course structure:', error);
      return null;
    }
  }

  /**
   * Extract all sections and lectures
   */
  private static extractSections(): UdemySection[] {
    const sections: UdemySection[] = [];
    const selector = '[data-purpose^="section-panel"], [data-purpose="curriculum-section"], .ud-accordion-panel, [class*="accordion-panel"], [class*="section--panel"], [class*="section--section"], .curriculum-section';
    const candidates = [...document.querySelectorAll(selector)].filter(element =>
      element.querySelector('[data-purpose="item-title"], a[href*="/learn/lecture/"], [data-purpose^="curriculum-item-"]')
    );
    // Keep the wrapper containing both the heading and its items, rather than
    // a nested content wrapper which would discard the chapter name.
    const titled = candidates.filter(element => element.querySelector(SELECTORS.SECTION_TITLE));
    const sectionElements = candidates.filter(element => {
      if (titled.includes(element)) {
        return !titled.some(other => other !== element && element.contains(other));
      }
      return !titled.some(other => other.contains(element)) &&
        !candidates.some(other => other !== element && element.contains(other));
    });

    sectionElements.forEach((sectionEl, index) => {
      const title = this.extractSectionTitle(sectionEl);
      const duration = this.extractSectionDuration(sectionEl);
      const lectures = this.extractLectures(sectionEl, index);

      log.debug(`🎯 Course structure debug - Section ${index}:`, {
        title, 
        duration, 
        lectureCount: lectures.length,
        sectionElementClasses: sectionEl.className
      });

      sections.push({
        id: `section-${index}`,
        title: title,
        duration: duration,
        lectures: lectures
      });
    });

    log.debug('🎯 Course structure debug - Total sections extracted:', sections.length);
    return sections;
  }

  /**
   * Extract section title
   */
  private static extractSectionTitle(sectionEl: Element): string {
    const titleEl = sectionEl.querySelector(SELECTORS.SECTION_TITLE);
    return titleEl?.textContent?.trim() || 'Untitled Section';
  }

  /**
   * Extract section duration
   */
  private static extractSectionDuration(sectionEl: Element): string {
    const durationEl = sectionEl.querySelector('[data-purpose="section-duration"]');
    const durationText = durationEl?.textContent?.trim() || '';
    // Extract duration from format like "0 / 2 | 38min"
    const match = durationText.match(/\|\s*(\d+min|\d+hr\s*\d+min)/);
    return match ? match[1] : '';
  }

  /**
   * Extract lectures from a section
   */
  private static extractLectures(sectionEl: Element, sectionIndex = 0): UdemyLecture[] {
    const lectures: UdemyLecture[] = [];
    
    // Try multiple selectors to find lectures
    const lectureSelectors = [
      SELECTORS.SIDEBAR_LECTURES,
      '[data-purpose^="curriculum-item-"]',
      '[class*="curriculum-item-link--curriculum-item"]',
      '.curriculum-item-link',
      '[data-purpose*="curriculum-item"]',
      'a[href*="/learn/lecture/"]',
      '.ud-accordion-panel-content a[href*="/learn/lecture/"]'
    ];

    let lectureElements: Element[] = [];
    let usedSelector = '';

    // Try each selector until we find lectures
    for (const selector of lectureSelectors) {
      const matches = [...sectionEl.querySelectorAll(selector)];
      lectureElements = matches.filter(element =>
        !matches.some(other => other !== element && other.contains(element))
      );
      if (lectureElements.length > 0) {
        usedSelector = selector;
        break;
      }
    }

    log.debug(`🎯 Course structure debug - Section lectures found:`, {
      sectionTitle: this.extractSectionTitle(sectionEl),
      lectureCount: lectureElements?.length || 0,
      usedSelector: usedSelector
    });

    const courseSlugMatch = typeof window !== 'undefined'
      ? window.location.pathname.match(/\/course\/([^/]+)/)
      : null;
    const courseSlug = courseSlugMatch ? courseSlugMatch[1] : '';

    const resolveItem = (el: Element, fallbackIndex: number) => {
      const linkEl = el.matches('a[href*="/learn/lecture/"]')
        ? (el as HTMLAnchorElement)
        : (el.querySelector('a[href*="/learn/lecture/"]') as HTMLAnchorElement | null);
      const rawHref = linkEl?.getAttribute('href') || el.getAttribute('href') || undefined;
      let url: string | undefined = undefined;
      if (rawHref) {
        try {
          url = new URL(rawHref, window.location.origin).href;
        } catch {
          url = rawHref;
        }
      }

      const rawPurpose =
        el.getAttribute('data-purpose') ||
        el.querySelector('[data-purpose^="curriculum-item-"]')?.getAttribute('data-purpose') ||
        el.getAttribute('data-item-id') ||
        '';

      const purposeMatch = rawPurpose.match(/^(?:curriculum-item-|item-)?(\d+)$/);
      const lectureIdMatch = (rawHref || '').match(/\/learn\/lecture\/(\d+)/);
      // Udemy Business uses positional curriculum-item-0-0 attributes.
      // Its completion label retains the real lecture ID even without a link.
      const completionId = el.querySelector('[id^="item-completion-state-"]')?.id.match(/^item-completion-state-(\d+)$/)?.[1];
      const id = lectureIdMatch?.[1] || completionId || purposeMatch?.[1] || `lecture-${sectionIndex}-${fallbackIndex}`;

      if (!url && id && !id.startsWith('lecture-') && courseSlug && typeof window !== 'undefined') {
        url = `${window.location.origin}/course/${courseSlug}/learn/lecture/${id}`;
      }

      return { id, url };
    };

    if (!lectureElements || lectureElements.length === 0) {
      const allLinks = sectionEl.querySelectorAll('a[href*="/learn/lecture/"], [data-purpose*="curriculum-item"]');
      log.debug(`🎯 Course structure debug - Fallback: found ${allLinks.length} lecture links`);

      allLinks.forEach((linkEl, index) => {
        const title = linkEl.textContent?.trim() || 'Untitled Lecture';
        const duration = this.extractLectureDuration(linkEl);
        const isCurrent = linkEl.classList.contains('curriculum-item-link--is-current--2mKk4') ||
                         linkEl.classList.contains('is-current');
        const { id, url } = resolveItem(linkEl, index);

        lectures.push({
          id,
          title,
          duration,
          isCurrent,
          url,
        });
      });
    } else {
      lectureElements.forEach((lectureEl, index) => {
        const title = this.extractLectureTitle(lectureEl);
        const icons = [...lectureEl.querySelectorAll('use')]
          .map(element => element.getAttribute('href') || element.getAttribute('xlink:href') || '')
          .join(' ');
        const kind = lectureEl.matches('a[href*="/quiz/"]') ||
          lectureEl.querySelector('[data-purpose="quiz-icon"], a[href*="/quiz/"]') || icons.includes('quiz')
          ? 'quiz' : lectureEl.querySelector('[data-purpose="article-icon"]') || icons.includes('article') ? 'article' : 'video';
        const duration = this.extractLectureDuration(lectureEl);
        const isCurrent = lectureEl.classList.contains('curriculum-item-link--is-current--2mKk4') ||
                         lectureEl.classList.contains('is-current');
        const { id, url } = resolveItem(lectureEl, index);

        lectures.push({
          id,
          title,
          duration,
          isCurrent,
          url,
          kind,
        });
      });
    }

    return lectures;
  }

  /**
   * Extract lecture title
   */
  private static extractLectureTitle(lectureEl: Element): string {
    // Try multiple selectors for lecture title
    const titleSelectors = [
      SELECTORS.LECTURE_ITEM_TITLE,
      '[data-purpose="item-title"]',
      '.curriculum-item-link--item-title--3Qj8Y',
      '.ud-heading-sm',
      '.ud-text-sm',
      'span[data-purpose="item-title"]',
      'a[data-purpose="item-title"]'
    ];

    for (const selector of titleSelectors) {
      const titleEl = lectureEl.querySelector(selector);
      if (titleEl && titleEl.textContent?.trim()) {
        return titleEl.textContent.trim();
      }
    }

    // Fallback: use the element's own text content
    const ownText = lectureEl.textContent?.trim();
    if (ownText && ownText.length > 0 && ownText.length < 200) {
      return ownText;
    }

    return 'Untitled Lecture';
  }

  /**
   * Extract lecture duration
   */
  private static extractLectureDuration(lectureEl: Element): string {
    const durationEl = lectureEl.querySelector('.curriculum-item-link--metadata--XK804 span:last-child, .ud-text-xs span:last-child');
    return durationEl?.textContent?.trim() || '';
  }

  /**
   * Get current lecture
   */
  private static getCurrentLecture(): UdemyLecture | undefined {
    const currentEl = document.querySelector('.curriculum-item-link--is-current--2mKk4');
    if (!currentEl) return undefined;

    return {
      id: 'current-lecture',
      title: this.extractLectureTitle(currentEl),
      duration: this.extractLectureDuration(currentEl),
      isCurrent: true
    };
  }

  /**
   * Get course title
   */
  private static getCourseTitle(): string {
    const titleEl = document.querySelector(SELECTORS.COURSE_TITLE);
    const title = titleEl?.textContent?.trim();
    if (title) return title;
    const headerLink = document.querySelector('header a[href*="/course/"]');
    if (headerLink?.textContent?.trim()) return headerLink.textContent.trim();
    const pageTitle = document.title.replace(/^Course:\s*/i, '').replace(/\s*[|–-]\s*Udemy(?: Business)?\s*$/i, '').trim();
    return pageTitle || 'Untitled Course';
  }

  /**
   * Get instructor name
   */
  private static getInstructorName(): string {
    const instructorEl = document.querySelector('[data-purpose="instructor-name"], .instructor-name');
    return instructorEl?.textContent?.trim() || 'Unknown Instructor';
  }

  /**
   * Test course structure selectors specifically
   */
  static testCourseStructureSelectors(): void {
    log.debug('🎯 === COURSE STRUCTURE SELECTORS TEST ===');
    
    // Test section selectors
    const sectionSelectors = [
      SELECTORS.SIDEBAR_SECTIONS,
      '[data-purpose="curriculum-section"]',
      '.ud-accordion-panel',
      '.curriculum-section',
      '[data-purpose*="section"]'
    ];

    log.debug('🎯 Section Selectors Test:');
    sectionSelectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      log.debug(`  ${selector}: ${elements.length} elements found`);
      if (elements.length > 0) {
        log.debug(`    First element classes: "${elements[0].className}"`);
        log.debug(`    First element text: "${elements[0].textContent?.substring(0, 100)}..."`);
      }
    });

    // Test lecture selectors
    const lectureSelectors = [
      SELECTORS.SIDEBAR_LECTURES,
      '[data-purpose^="curriculum-item-"]',
      '.curriculum-item-link',
      '[data-purpose*="curriculum-item"]',
      'a[href*="/learn/lecture/"]'
    ];

    log.debug('🎯 Lecture Selectors Test:');
    lectureSelectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      log.debug(`  ${selector}: ${elements.length} elements found`);
      if (elements.length > 0) {
        log.debug(`    First element classes: "${elements[0].className}"`);
        log.debug(`    First element text: "${elements[0].textContent?.substring(0, 100)}..."`);
      }
    });

    // Test title selectors
    const titleSelectors = [
      SELECTORS.LECTURE_ITEM_TITLE,
      '[data-purpose="item-title"]',
      '.curriculum-item-link--item-title--3Qj8Y',
      '.ud-heading-sm',
      '.ud-text-sm'
    ];

    log.debug('🎯 Title Selectors Test:');
    titleSelectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      log.debug(`  ${selector}: ${elements.length} elements found`);
      if (elements.length > 0) {
        log.debug(`    First element text: "${elements[0].textContent?.trim()}"`);
      }
    });

    // Test all links that might be lectures
    const allLectureLinks = document.querySelectorAll('a[href*="/learn/lecture/"]');
    log.debug(`🎯 All lecture links found: ${allLectureLinks.length}`);
    if (allLectureLinks.length > 0) {
      log.debug('  Sample lecture links:');
      const sampleCount = Math.min(5, allLectureLinks.length);
      for (let i = 0; i < sampleCount; i++) {
        const link = allLectureLinks[i];
        log.debug(`    ${i + 1}. "${link.textContent?.trim()}" (${link.getAttribute('href')})`);
      }
    }
  }

  /**
   * Test all selectors to find the most reliable ones
   */
  static testAllSelectors(): void {
    log.debug('🎯 === COMPREHENSIVE SELECTOR TESTING STARTED ===');
    
    // Test transcript panel selectors
    const panelSelectors = [
      '[data-purpose="transcript-panel"]',
      '.transcript-panel',
      '[data-test="transcript-panel"]',
      '.transcript--transcript-panel--JLceZ',
      '.captions-display--captions-container--PqdGQ',
      '[class*="transcript"]',
      '[class*="captions"]',
      '[class*="subtitles"]'
    ];
    
    log.debug('🎯 === PANEL SELECTORS TEST ===');
    panelSelectors.forEach(selector => {
      const element = document.querySelector(selector);
      log.debug(`  ${selector}: ${element ? '✅ FOUND' : '❌ NOT FOUND'}`);
      if (element) {
        log.debug(`    Text content: "${element.textContent?.substring(0, 100)}..."`);
        log.debug(`    Children count: ${element.children.length}`);
        log.debug(`    Classes: "${element.className}"`);
        log.debug(`    Visible: ${(element as HTMLElement).offsetParent !== null}`);
        log.debug(`    Dimensions: ${(element as HTMLElement).offsetWidth}x${(element as HTMLElement).offsetHeight}`);
      }
    });
    
    // Test entry selectors with detailed analysis
    const entrySelectors = [
      '[data-purpose="transcript-cue"]',
      '.transcript--cue-container--Vuwj6',
      '.transcript--underline-cue---xybZ',
      '.transcript-cue',
      '[data-timestamp]',
      '.timestamp-item',
      '.transcript-line',
      'div[role="button"]',
      'button[data-purpose*="transcript"]',
      '.captions-display--captions-cue-text--TQ0DQ',
      '[class*="cue"]',
      '[class*="timestamp"]'
    ];
    
    log.debug('🎯 === ENTRY SELECTORS TEST ===');
    entrySelectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      log.debug(`  ${selector}: ${elements.length} elements found`);
      if (elements.length > 0) {
        log.debug(`    First element text: "${elements[0].textContent?.substring(0, 50)}..."`);
        log.debug(`    First element classes: "${elements[0].className}"`);
        log.debug(`    First element tag: "${elements[0].tagName}"`);
        
        // Show sample of first few elements
        const sampleCount = Math.min(3, elements.length);
        for (let i = 0; i < sampleCount; i++) {
          const text = elements[i].textContent?.trim();
          if (text) {
            log.debug(`    Sample ${i + 1}: "${text.substring(0, 80)}..."`);
          }
        }
      }
    });
    
    // Test button selectors
    const buttonSelectors = [
      'button[data-purpose="transcript-toggle"]',
      '[data-purpose="transcript-toggle"]',
      '.transcript-toggle',
      '[aria-label*="transcript" i]',
      'button[aria-label*="transcript" i]',
      '[aria-label*="captions" i]',
      'button[aria-label*="captions" i]',
      '[aria-label*="subtitles" i]',
      'button[aria-label*="subtitles" i]'
    ];
    
    log.debug('🎯 === BUTTON SELECTORS TEST ===');
    buttonSelectors.forEach(selector => {
      const element = document.querySelector(selector);
      log.debug(`  ${selector}: ${element ? '✅ FOUND' : '❌ NOT FOUND'}`);
      if (element) {
        log.debug(`    Button text: "${element.textContent?.trim()}"`);
        log.debug(`    Button classes: "${element.className}"`);
        log.debug(`    Button visible: ${(element as HTMLElement).offsetParent !== null}`);
        log.debug(`    Button disabled: ${(element as HTMLButtonElement).disabled}`);
        log.debug(`    Aria-label: "${element.getAttribute('aria-label')}"`);
        log.debug(`    Data-purpose: "${element.getAttribute('data-purpose')}"`);
      }
    });
    
    // Test all buttons on page for transcript-related content
    log.debug('🎯 === ALL BUTTONS ANALYSIS ===');
    const allButtons = document.querySelectorAll('button');
    log.debug(`  Total buttons found: ${allButtons.length}`);
    
    const transcriptButtons = Array.from(allButtons).filter(btn => {
      const text = btn.textContent?.toLowerCase() || '';
      const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
      const dataPurpose = btn.getAttribute('data-purpose')?.toLowerCase() || '';
      const className = btn.className.toLowerCase();
      
      return text.includes('transcript') || text.includes('captions') || text.includes('subtitles') ||
             ariaLabel.includes('transcript') || ariaLabel.includes('captions') || ariaLabel.includes('subtitles') ||
             dataPurpose.includes('transcript') || dataPurpose.includes('captions') || dataPurpose.includes('subtitles') ||
             className.includes('transcript') || className.includes('captions') || className.includes('subtitles');
    });
    
    log.debug(`  Transcript-related buttons found: ${transcriptButtons.length}`);
    transcriptButtons.forEach((btn, i) => {
      log.debug(`    Button ${i + 1}:`);
      log.debug(`      Text: "${btn.textContent?.trim()}"`);
      log.debug(`      Aria-label: "${btn.getAttribute('aria-label')}"`);
      log.debug(`      Data-purpose: "${btn.getAttribute('data-purpose')}"`);
      log.debug(`      Classes: "${btn.className}"`);
      log.debug(`      Visible: ${(btn as HTMLElement).offsetParent !== null}`);
      log.debug(`      Disabled: ${btn.disabled}`);
    });
    
    // Test video element and text tracks
    log.debug('🎯 === VIDEO ELEMENT TEST ===');
    const video = document.querySelector('video');
    if (video) {
      log.debug(`  Video element found: ${video.tagName}`);
      log.debug(`  Video src: "${video.src}"`);
      log.debug(`  Video currentTime: ${video.currentTime}`);
      log.debug(`  Video duration: ${video.duration}`);
      
      const tracks = Array.from(video.textTracks || []);
      log.debug(`  Text tracks found: ${tracks.length}`);
      tracks.forEach((track, i) => {
        log.debug(`    Track ${i + 1}:`);
        log.debug(`      Kind: "${track.kind}"`);
        log.debug(`      Label: "${track.label}"`);
        log.debug(`      Language: "${track.language}"`);
        log.debug(`      Mode: "${track.mode}"`);
        log.debug(`      Cues count: ${track.cues?.length || 0}`);
      });
    } else {
      log.debug('  No video element found');
    }
    
    // Test for any transcript-related elements by class name
    log.debug('🎯 === TRANSCRIPT-RELATED ELEMENTS BY CLASS ===');
    const transcriptElements = document.querySelectorAll('[class*="transcript"], [class*="captions"], [class*="subtitles"], [class*="cc"]');
    log.debug(`  Total transcript-related elements: ${transcriptElements.length}`);
    
    const classGroups: { [key: string]: Element[] } = {};
          transcriptElements.forEach(el => {
        // Check if className is a string (SVG elements might have DOMTokenList)
        const className = typeof el.className === 'string' ? el.className : (el.className as any).baseVal || '';
        if (className) {
          const classes = className.split(' ').filter(cls => 
            cls.includes('transcript') || cls.includes('captions') || cls.includes('subtitles') || cls.includes('cc')
          );
          classes.forEach(cls => {
            if (!classGroups[cls]) classGroups[cls] = [];
            classGroups[cls].push(el);
          });
        }
      });
    
    Object.entries(classGroups).forEach(([className, elements]) => {
      log.debug(`    Class "${className}": ${elements.length} elements`);
      if (elements.length <= 3) {
        elements.forEach((el, i) => {
          const text = el.textContent?.trim().substring(0, 50);
          log.debug(`      Element ${i + 1}: "${text}..."`);
        });
      }
    });
    
    log.debug('🎯 === SELECTOR TESTING COMPLETED ===');
  }

  /**
   * Extract transcript for current video
   * Optimized version with reduced delays and better error handling
   */
  static async extractTranscript(): Promise<string> {
    try {
      log.debug('🎯 Starting transcript extraction...');
      
      // Wait for video to be ready dynamically
      const video = await this.waitForVideoReady(3000);
      if (!video) {
        throw new Error('Video not ready for transcript extraction');
      }

      // Fast path: If HTML5 text tracks already carry cues, return immediately without DOM scrolling
      if (video.textTracks && video.textTracks.length > 0) {
        const trackLines = await this.extractFromTextTracks();
        if (trackLines.length >= 20) {
          log.debug(`🎯 Fast path: Extracted ${trackLines.length} cues from text tracks.`);
          return trackLines.join('\n\n');
        }
      }
      
      // Quick hover to show controls (dynamic timing)
      const videoContainer = document.querySelector('.video-viewer--video-viewer--0IkCW') || 
                            document.querySelector('[data-purpose="video-display"]') ||
                            video;
      
      if (videoContainer) {
        const hoverEvent = new MouseEvent('mousemove', {
          bubbles: true,
          cancelable: true,
          clientX: 400,
          clientY: 300
        });
        videoContainer.dispatchEvent(hoverEvent);
        // No fixed delay - proceed immediately
      }
      
      // Ensure transcript is active with dynamic timing
      log.debug('🎯 Ensuring transcript is active...');
      await this.ensureTranscriptActive();
      
      let transcriptParts: string[] = [];
      
      // Method 1: Try transcript panel first (fastest)
      log.debug('🎯 Method 1: Trying transcript panel...');

      // Udemy renames its generated class names between builds, so match on
      // several shapes rather than one. A single hardcoded selector silently
      // turns "the panel moved" into "this video has no captions".
      const panelSelectors = [
        '[data-purpose="transcript-panel"]',
        '[data-purpose^="transcript"]',
        '[class*="transcript--transcript-panel"]',
        '[class*="transcript-panel"]',
        '[data-purpose="sidebar-content"]',
      ];

      const entrySelectors = [
        '[data-purpose="transcript-cue"]',
        '[class*="transcript--cue-container"]',
        '.transcript--cue-container--Vuwj6',
        '.transcript-cue',
        '[class*="cue-container"]',
        '[data-purpose="cue-text"]',
      ];

      /**
       * A candidate is only the transcript panel if it actually contains cues.
       *
       * Matching on the element alone let a loose selector pick up unrelated
       * page furniture — on the Overview tab it matched a container whose text
       * was the course description, and that got scraped as if it were the
       * lecture. Requiring cue elements inside makes the match self-validating.
       */
      let transcriptPanel: Element | null = null;
      let transcriptEntries: NodeListOf<Element> | null = null;

      for (const panelSelector of panelSelectors) {
        for (const candidate of document.querySelectorAll(panelSelector)) {
          for (const entrySelector of entrySelectors) {
            const entries = candidate.querySelectorAll(entrySelector);
            if (entries.length > 0) {
              transcriptPanel = candidate;
              transcriptEntries = entries;
              log.debug(
                `🎯 Transcript panel matched: ${panelSelector} (cues via ${entrySelector})`,
              );
              break;
            }
          }
          if (transcriptPanel) break;
        }
        if (transcriptPanel) break;
      }

      if (!transcriptPanel) {
        log.debug('🎯 No transcript panel with cue elements found in the DOM.');
      }

      let panelCueCount = 0;

      if (transcriptPanel) {
        panelCueCount = transcriptEntries?.length ?? 0;
        log.debug('🎯 Cue elements visible in the panel:', panelCueCount);

        if (transcriptEntries && transcriptEntries.length > 0) {
          // The panel is virtualised: only the cues near the current scroll
          // offset exist in the DOM. A single querySelectorAll therefore
          // captures ~15 cues out of hundreds, and the result looks like a
          // successful extraction of a very short lecture.
          transcriptParts = await this.collectCuesByScrolling(transcriptPanel, entrySelectors);
        }
      }

      // Method 2: HTML5 text tracks.
      //
      // Run this whenever the panel produced suspiciously little, not only when
      // it produced nothing — a partial scrape is worse than a fallback,
      // because it silently truncates the lecture. Text tracks give every cue
      // at once, so whichever source yields more wins.
      const panelCount = transcriptParts.length;
      if (panelCount < 40) {
        log.debug(`🎯 Method 2: panel gave ${panelCount} cues, trying HTML5 text tracks...`);
        const trackLines = await this.extractFromTextTracks();
        if (trackLines.length > panelCount) {
          log.debug(`🎯 Text tracks gave ${trackLines.length} cues; using those.`);
          transcriptParts = trackLines;
        }
      }

      if (transcriptParts.length === 0) {
        // Say which of the three very different failures this actually is.
        // "May not have captions" is wrong — and unactionable — when the real
        // problem is a closed panel or a video that has not started.
        if (!transcriptPanel) {
          throw new Error(
            'Could not find the transcript panel. Open the lecture (not the Overview tab), click "Transcript" under the player, then extract again.',
          );
        }
        if (panelCueCount === 0) {
          throw new Error(
            'The transcript panel is open but empty. Give it a moment to load, or press play briefly, then extract again.',
          );
        }
        throw new Error(
          `Found ${panelCueCount} transcript rows but could not read text from them. Udemy may have changed its markup — please report this.`,
        );
      }

      // Udemy renders transcript text without times and exposes no native text
      // tracks, so a panel scrape often carries no timings at all. Estimate
      // them from the video duration rather than shipping a transcript that
      // cannot be linked back to the lecture at all.
      const hasAnyTimestamp = transcriptParts.some((line) => /^\[\d{1,2}:\d{2}/.test(line));
      if (!hasAnyTimestamp) {
        const videoEl = document.querySelector('video') as HTMLVideoElement | null;
        const duration = videoEl?.duration ?? 0;

        if (Number.isFinite(duration) && duration > 0) {
          const estimated = estimateCueTimings(
            transcriptParts.map((text) => ({ startSeconds: null, text })),
            duration,
          );
          transcriptParts = estimated.map(
            (cue) => `[${this.formatTime(cue.startSeconds ?? 0)}] ${cue.text}`,
          );
          transcriptParts.unshift(ESTIMATED_TIMING_MARKER);
          log.debug(
            `🎯 No timings in the DOM; estimated from ${Math.round(duration)}s of video.`,
          );
        } else {
          log.debug('🎯 No timings available, and no video duration to estimate from.');
        }
      }

      log.debug('🎯 Transcript extraction completed:', transcriptParts.length, 'parts');
      return transcriptParts.join('\n\n');
    } catch (error) {
      console.error('Error extracting transcript:', error);
      throw new Error(`Failed to extract transcript: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Read every cue out of a virtualised transcript panel.
   *
   * Udemy only keeps the cues near the current scroll offset in the DOM, so a
   * single query returns a handful of lines regardless of how long the lecture
   * is. Walking the panel top to bottom and accumulating as cues render is the
   * only way to see all of them.
   *
   * Cues are keyed by timestamp, so the overlap between scroll steps collapses
   * instead of duplicating, and the scroll position is restored afterwards —
   * the user did not ask us to move their transcript panel.
   */
  private static async collectCuesByScrolling(
    panel: Element,
    entrySelectors: readonly string[],
  ): Promise<string[]> {
    const scroller = this.findScrollableElement(panel);
    const originalScrollTop = scroller ? scroller.scrollTop : 0;

    // Cues are kept in the order they appear, not keyed by timestamp.
    // Udemy does not always put a timestamp in the cue's own text — it is often
    // a sibling element or absent entirely — so requiring one throws the whole
    // transcript away. Scrolling top to bottom means DOM order is already the
    // right order; a seen-set collapses the overlap between scroll steps.
    const collected: { seconds: number | null; text: string }[] = [];
    const seen = new Set<string>();

    /** Pull the timestamp from the cue text, a sibling, or a data attribute. */
    const readTimestamp = (entry: Element, fullText: string): number | null => {
      const inline = fullText.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\b/);
      if (inline) return this.parseTimestampToSeconds(inline[1]);

      const stamped = entry.querySelector('[data-purpose*="cue-time"], time, .transcript--underline-cue--9Tzw6');
      const stampText = stamped?.textContent?.trim();
      if (stampText) {
        const match = stampText.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
        if (match) return this.parseTimestampToSeconds(match[1]);
      }

      const attr =
        entry.getAttribute('data-start') ??
        entry.getAttribute('data-time') ??
        entry.getAttribute('data-purpose-start');
      if (attr && Number.isFinite(Number(attr))) return Math.floor(Number(attr));

      return null;
    };

    const harvest = () => {
      for (const selector of entrySelectors) {
        const entries = panel.querySelectorAll(selector);
        if (entries.length === 0) continue;

        entries.forEach((entry) => {
          const fullText = entry.textContent?.trim() || '';
          if (!fullText || fullText === '...' || fullText.length < 3) return;

          const seconds = readTimestamp(entry, fullText);
          // Strip a leading timestamp from the text when there was one.
          const text = fullText.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/, '').trim();
          if (!text || text.length < 3 || !/[a-zA-Z]/.test(text)) return;

          const key = text.toLowerCase().replace(/\s+/g, ' ');
          if (seen.has(key)) return;
          seen.add(key);
          collected.push({ seconds, text });
        });
        break;
      }
    };

    // Start from the top, not from wherever the panel happens to be sitting.
    //
    // Udemy autoscrolls the transcript to follow playback, so on a lecture the
    // user has been watching the panel opens mid-way through. Harvesting from
    // there and only ever scrolling down means the opening lines are gathered
    // last — or, if the scroll never returns above the starting offset, not at
    // all.
    if (scroller && scroller.scrollTop > 0) {
      scroller.scrollTop = 0;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    harvest();

    if (scroller && scroller.scrollHeight > scroller.clientHeight) {
      const step = Math.max(120, Math.floor(scroller.clientHeight * 0.8));
      // Bounded so a panel that grows as it loads cannot spin forever.
      const maxSteps = Math.min(400, Math.ceil(scroller.scrollHeight / step) + 10);

      for (let i = 0; i < maxSteps; i++) {
        const previousTop = scroller.scrollTop;
        scroller.scrollTop = Math.min(previousTop + step, scroller.scrollHeight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        harvest();

        // Reached the bottom, or the panel refused to scroll further.
        if (scroller.scrollTop <= previousTop) break;
      }

      scroller.scrollTop = originalScrollTop;
    }

    const timed = collected.filter((cue) => cue.seconds !== null).length;
    log.debug(
      `🎯 Collected ${collected.length} cues from the transcript panel (${timed} with timestamps).`,
    );

    // Order by the clock, anchoring untimed cues to the line before them.
    //
    // This used to sort only when every single cue carried a timestamp, so one
    // untimed line discarded the ordering of the several hundred around it and
    // the transcript fell back to harvest order — which is exactly the order
    // that cannot be trusted.
    const ordered = orderCollectedCues(collected);

    return ordered.map((cue) =>
      cue.seconds === null ? cue.text : `[${this.formatTime(cue.seconds)}] ${cue.text}`,
    );
  }

  /**
   * The element that actually scrolls the transcript.
   *
   * Searched in both directions and scored, rather than taking the first
   * plausible ancestor. Udemy has moved this between the panel, a wrapper above
   * it and an inner list across builds, and picking the wrong one means the
   * scroll does nothing — which looks exactly like "this lecture has 14 cues".
   */
  private static findScrollableElement(start: Element): HTMLElement | null {
    const candidates: HTMLElement[] = [];

    // Self and ancestors.
    let node: Element | null = start;
    for (let depth = 0; node && depth < 8; depth++) {
      candidates.push(node as HTMLElement);
      node = node.parentElement;
    }

    // Descendants — on some builds the list inside the panel is the scroller.
    for (const el of start.querySelectorAll<HTMLElement>('*')) {
      candidates.push(el);
      // A transcript panel has few enough children that this stays cheap, but
      // bound it anyway rather than walking a pathological tree.
      if (candidates.length > 400) break;
    }

    let best: HTMLElement | null = null;
    let bestOverflow = 8; // Require a real overflow, not a rounding difference.

    for (const el of candidates) {
      const overflow = el.scrollHeight - el.clientHeight;
      if (overflow <= bestOverflow) continue;

      const style = getComputedStyle(el).overflowY;
      if (style !== 'auto' && style !== 'scroll' && style !== 'overlay') continue;

      best = el;
      bestOverflow = overflow;
    }

    return best;
  }

  /** "MM:SS" or "HH:MM:SS" to seconds; null when it is not a timestamp. */
  private static parseTimestampToSeconds(value: string): number | null {
    const parts = value.split(':').map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  /**
   * Fallback extraction via HTML5 text tracks (optimized version)
   */
  private static async extractFromTextTracks(): Promise<string[]> {
    const lines: string[] = [];
    try {
      const video = document.querySelector('video') as HTMLVideoElement | null;
      if (!video || !video.textTracks) {
        log.debug('🎯 No video element or textTracks found');
        return lines;
      }

      const tracks = Array.from(video.textTracks);
      if (!tracks.length) {
        log.debug('🎯 No text tracks available');
        return lines;
      }

      // Caption tracks first, but try every one: the first track is often an
      // empty placeholder, and giving up on it loses the whole transcript.
      const ordered = [
        ...tracks.filter((t) => t.kind === 'captions'),
        ...tracks.filter((t) => t.kind === 'subtitles'),
        ...tracks.filter((t) => t.kind !== 'captions' && t.kind !== 'subtitles'),
      ];

      let best: string[] = [];

      for (const track of ordered) {
        const originalMode = track.mode;
        try {
          // 'hidden' loads the cues without drawing subtitles over the video.
          // The previous 'showing' turned the user's captions on and left them
          // on — a visible side effect of pressing Extract.
          if (track.mode === 'disabled') track.mode = 'hidden';
          await this.waitForCuesToLoad(track, 2500);

          const cues = track.cues ? Array.from(track.cues as any) : [];
          if (cues.length === 0) continue;

          const current: string[] = [];
          cues.forEach((cue: any) => {
            const start = this.formatTime(cue.startTime || 0);
            const text = (cue.text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (text && text.length > 3) current.push(`[${start}] ${text}`);
          });

          log.debug(`🎯 Track "${track.label || track.language}": ${current.length} cues`);
          if (current.length > best.length) best = current;
        } finally {
          // Put the user's caption setting back exactly as we found it.
          track.mode = originalMode;
        }
      }

      lines.push(...best);
      log.debug('🎯 Extracted', lines.length, 'lines from text tracks');

    } catch (err) {
      log.debug('🎯 Text tracks extraction failed:', err);
    }
    return lines;
  }

  /**
   * Ensure transcript/captions are active for the current video
   * Optimized version with reduced delays and better error handling
   */
  private static async ensureTranscriptActive(): Promise<void> {
    log.debug('🎯 Ensuring transcript/captions are active...');
    const cues = document.querySelector('[data-purpose="transcript-cue"], [class*="cue-container"], [data-purpose="cue-text"]');
    if (cues?.textContent?.trim() && !cues.closest('[hidden], [aria-hidden="true"]')) return;
    
    // Check if transcript panel is already visible and has content
    const panelSelectors = [
      '[data-purpose="transcript-panel"]',
      '[data-purpose^="transcript"]',
      '[class*="transcript--transcript-panel"]',
      '[class*="transcript-panel"]',
    ];
    for (const selector of panelSelectors) {
      const existing = document.querySelector(selector);
      if (existing && (existing as HTMLElement).offsetParent !== null) {
        const hasCue = existing.querySelector(
          '[data-purpose="transcript-cue"], [class*="cue-container"], .transcript-cue'
        );
        if (hasCue) {
          log.debug('🎯 Transcript panel already active with content');
          return;
        }
      }
    }
    
    // Quick hover simulation to show controls (dynamic timing)
    const videoContainer = document.querySelector('.video-viewer--video-viewer--0IkCW') || 
                          document.querySelector('[data-purpose="video-display"]') ||
                          document.querySelector('.video-js') ||
                          document.querySelector('video');
    
    if (videoContainer) {
      const hoverEvent = new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: 400,
        clientY: 300
      });
      videoContainer.dispatchEvent(hoverEvent);
      // No fixed delay - proceed immediately
    }
    
    // Wait for transcript button to be available dynamically
    const transcriptButton = await this.waitForTranscriptButton(1500);
    
    if (transcriptButton) {
      log.debug('🎯 Clicking transcript button...');
      
      // Simple click without excessive event simulation
      if (transcriptButton.getAttribute('aria-expanded') !== 'true' &&
          transcriptButton.getAttribute('aria-pressed') !== 'true') transcriptButton.click();
      
      // Wait for panel to appear dynamically
      const panelReady = await this.waitForTranscriptElements(5000);
      if (panelReady) {
        log.debug('🎯 Transcript panel opened successfully');
        return;
      }
      
      // Try enabling captions if transcript panel didn't work
      log.debug('🎯 Trying captions activation...');
      await this.enableCaptions();
    } else {
      log.debug('🎯 No transcript button found, trying direct captions activation...');
      await this.enableCaptions();
    }
  }
  
  /**
   * Enable captions through various methods
   */
  private static async enableCaptions(): Promise<void> {
    // Method 1: Try captions dropdown with dynamic timing
    const captionsDropdown = await this.waitForElement('[data-purpose="captions-dropdown-button"]', 1000);
    if (captionsDropdown) {
      log.debug('🎯 Trying captions dropdown...');
      (captionsDropdown as HTMLElement).click();
      
      // Wait for dropdown to open dynamically
      await new Promise(resolve => setTimeout(resolve, 100)); // Minimal delay for dropdown animation
      
      // Look for English captions with dynamic timing
      const englishButton = [...document.querySelectorAll('button')].find(button =>
        /English/i.test(button.getAttribute('aria-label') || button.textContent || '')
      );
      if (englishButton) {
        (englishButton as HTMLElement).click();
        log.debug('🎯 English captions activated');
        return;
      }
    }
    
    // Method 2: Try video text tracks directly
    const video = document.querySelector('video') as HTMLVideoElement;
    if (video && video.textTracks) {
      log.debug('🎯 Trying video text tracks...');
      for (let i = 0; i < video.textTracks.length; i++) {
        const track = video.textTracks[i];
        if (track.language === 'en' || track.label.includes('English')) {
          track.mode = 'showing';
          log.debug('🎯 Text track enabled:', track.label);
          return;
        }
      }
    }
  }

  private static formatTime(totalSeconds: number): string {
    const sec = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
    const min = Math.floor((totalSeconds / 60) % 60).toString().padStart(2, '0');
    const hrs = Math.floor(totalSeconds / 3600);
    return hrs > 0 ? `${hrs}:${min}:${sec}` : `${min}:${sec}`;
  }

  /**
   * Wait for an element to appear in the DOM with dynamic timing
   */
  private static async waitForElement(selector: string, timeout: number = 5000): Promise<Element | null> {
    return new Promise((resolve) => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        return;
      }

      const observer = new MutationObserver((mutations) => {
        const element = document.querySelector(selector);
        if (element) {
          observer.disconnect();
          resolve(element);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  /**
   * Wait for video to be ready with dynamic timing
   */
  private static async waitForVideoReady(timeout: number = 3500): Promise<HTMLVideoElement | null> {
    return new Promise((resolve) => {
      const isReady = (v: HTMLVideoElement | null) => {
        if (!v) return false;
        return (
          v.readyState >= 1 ||
          (v.textTracks && v.textTracks.length > 0) ||
          v.duration > 0 ||
          Boolean(v.src || v.currentSrc)
        );
      };

      const initial = document.querySelector('video') as HTMLVideoElement | null;
      if (initial && (initial.readyState >= 2 || isReady(initial))) {
        resolve(initial);
        return;
      }

      let timer: any = null;
      const interval = setInterval(() => {
        const video = document.querySelector('video') as HTMLVideoElement | null;
        if (video && (video.readyState >= 2 || isReady(video))) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve(video);
        }
      }, 50);

      timer = setTimeout(() => {
        clearInterval(interval);
        // Fallback: If video exists at all, resolve it rather than rejecting
        const fallback = document.querySelector('video') as HTMLVideoElement | null;
        resolve(fallback);
      }, timeout);
    });
  }

  /**
   * Wait for transcript elements to be available with dynamic timing
   */
  private static async waitForTranscriptElements(timeout = 2000): Promise<boolean> {
    const deadline = Date.now() + timeout;
    do {
      const video = document.querySelector('video');
      if (document.querySelector('[data-purpose="transcript-cue"], [class*="cue-container"], [data-purpose="cue-text"]') ||
          (video?.textTracks.length ?? 0) > 0) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    return false;
  }

  /**
   * Wait for transcript button to be clickable with dynamic timing
   */
  private static async waitForTranscriptButton(timeout = 1500): Promise<HTMLElement | null> {
    const deadline = Date.now() + timeout;
    const selectors = ['button[data-purpose="transcript-toggle"]', '[data-purpose="transcript-toggle"]',
      'button[aria-label*="transcript" i]', 'button[title*="transcript" i]'];
    do {
      for (const selector of selectors) {
        const button = document.querySelector<HTMLElement>(selector);
        if (button && button.offsetParent !== null && !(button as HTMLButtonElement).disabled) return button;
      }
      const named = [...document.querySelectorAll<HTMLElement>('button, [role="tab"]')].find(button =>
        /^transcript$/i.test(button.textContent?.trim() || '') && button.offsetParent !== null &&
        !(button as HTMLButtonElement).disabled
      );
      if (named) return named;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    return null;
  }

  /**
   * Wait for text track cues to load with dynamic timing
   */
  private static async waitForCuesToLoad(track: TextTrack, timeout: number = 2000): Promise<void> {
    return new Promise((resolve) => {
      const checkCues = () => {
        if (track.cues && track.cues.length > 0) {
          resolve();
          return;
        }
        setTimeout(checkCues, 50); // Check every 50ms
      };

      checkCues();

      setTimeout(() => {
        resolve();
      }, timeout);
    });
  }

  /**
   * Check if we're on a Udemy course page
   */
  static isUdemyCoursePage(): boolean {
    const isUdemy = window.location.hostname.includes('udemy.com');
    const isCourse = window.location.pathname.includes('/course/');
    const result = isUdemy && isCourse;
    
    log.debug('UdemyExtractor.isUdemyCoursePage:', {
      hostname: window.location.hostname,
      pathname: window.location.pathname,
      isUdemy,
      isCourse,
      result
    });
    
    return result;
  }

  /**
   * Check if page is ready for transcript collection (faster check)
   */
  static isPageReadyForCollection(): boolean {
    // Quick check if basic elements are loaded
    const video = document.querySelector('video');
    const hasVideo = video && video.readyState >= 2; // HAVE_CURRENT_DATA or higher
    
    // Check if transcript elements exist (even if not visible)
    const hasTranscriptElements = document.querySelector('[data-purpose="transcript-panel"], [data-purpose="transcript-cue"], video[textTracks]');
    
    return !!(hasVideo && (hasTranscriptElements || video?.textTracks?.length > 0));
  }

  /**
   * Check if transcript is available for current video
   * Improved version that works regardless of transcript panel state
   */
  static isTranscriptAvailable(): boolean {
    log.debug('🎯 Checking transcript availability...');
    
    // Method 1: Check for existing transcript content (already visible)
    const existingContent = document.querySelector('[data-purpose="transcript-cue"]');
    if (existingContent) {
      log.debug('🎯 Transcript content already visible');
      return true;
    }
    
    // Method 2: Check for video text tracks (most reliable)
    const video = document.querySelector('video') as HTMLVideoElement | null;
    if (video && video.textTracks) {
      const tracks = Array.from(video.textTracks);
      log.debug('🎯 Video text tracks found:', tracks.length);
      
      for (const track of tracks) {
        if (track.kind === 'captions' || track.kind === 'subtitles') {
          log.debug(`🎯 Found ${track.kind} track: "${track.label}"`);
          return true; // If track exists, transcript is available
        }
      }
    }
    
    // Method 3: Check for transcript button (means transcript can be activated)
    const buttonSelectors = [
      'button[data-purpose="transcript-toggle"]',
      '[data-purpose="transcript-toggle"]',
      'button[aria-label*="transcript" i]',
      'button[aria-label*="captions" i]'
    ];
    
    for (const selector of buttonSelectors) {
      const button = document.querySelector(selector);
      if (button && (button as HTMLElement).offsetParent !== null) {
        log.debug(`🎯 Transcript button found: ${selector}`);
        return true;
      }
    }
    
    // Method 4: Check for captions dropdown (alternative access)
    const captionsDropdown = document.querySelector('[data-purpose="captions-dropdown-button"]');
    if (captionsDropdown && (captionsDropdown as HTMLElement).offsetParent !== null) {
      log.debug('🎯 Captions dropdown found');
      return true;
    }
    
    // Method 5: Check for any transcript-related elements
    const transcriptElements = document.querySelectorAll('[class*="transcript"], [class*="captions"], [class*="subtitles"]');
    if (transcriptElements.length > 0) {
      log.debug('🎯 Transcript-related elements found:', transcriptElements.length);
      return true;
    }
    
    log.debug('🎯 No transcript availability detected');
    return false;
  }

  /**
   * Get current video information
   */
  static getCurrentVideoInfo(): { title: string; duration: string } | null {
    try {
      // Try to get current lecture first
      const currentLecture = this.getCurrentLecture();
      if (currentLecture) {
        return {
          title: currentLecture.title,
          duration: currentLecture.duration
        };
      }

      // Fallback: try to get video title from page
      const videoTitle = this.getVideoTitleFromPage();
      if (videoTitle) {
        return {
          title: videoTitle,
          duration: 'Unknown'
        };
      }

      return null;
    } catch (error) {
      console.error('Error getting current video info:', error);
      return null;
    }
  }

  /**
   * Get video title from page
   */
  private static getVideoTitleFromPage(): string | null {
    // Try multiple selectors for video title
    const titleSelectors = [
      '[data-purpose="lecture-title"]',
      'h1[data-purpose*="title"]',
      '.lecture-title',
      '.video-title',
      'h1',
      '.ud-heading-xl'
    ];

    for (const selector of titleSelectors) {
      const element = document.querySelector(selector);
      if (element && element.textContent?.trim()) {
        return element.textContent.trim();
      }
    }

    // Try to get from page title as fallback
    const pageTitle = document.title;
    if (pageTitle && pageTitle.includes('|')) {
      return pageTitle.split('|')[0].trim();
    }

    return null;
  }
}
