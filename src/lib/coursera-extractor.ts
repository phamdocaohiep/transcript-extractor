import { log } from './log';
import { parseTimestamp, formatTimestamp } from './transcript';
import { errorMessage } from './utils';
import { parseCaptionFile } from './caption-formats';
import { lectureId } from './collection';
// Coursera Extractor for Transcript Extractor Extension
// Handles transcript extraction from Coursera course videos

export interface CourseraVideo {
  title: string;
  videoId: string;
  url: string;
  hasTranscript: boolean;
}

export interface CourseraTranscriptEntry {
  timestamp: string;
  text: string;
}

export class CourseraExtractor {
  /**
   * Check if current page is a Coursera course page
   */
  static isCourseraCoursePage(): boolean {
    try {
      const url = window.location.href;
      const hostname = window.location.hostname;
      const pathname = window.location.pathname;

      const isCoursera = hostname === 'coursera.org' || hostname.endsWith('.coursera.org');
      const isLearn = pathname.includes('/learn/');
      const isLecture = pathname.includes('/lecture/');
      const isReading = pathname.includes('/reading/');

      return isCoursera && (isLearn || isLecture || isReading);
    } catch (error) {
      console.error('Error checking Coursera page:', error);
      return false;
    }
  }

  /**
   * Check if transcript or reading content is available on current page
   */
  static isTranscriptAvailable(): boolean {
    try {
      // Check for video transcript
      const transcriptPanel = document.querySelector('[role="tabpanel"]');
      if (transcriptPanel) {
        const transcriptContent = document.querySelector('.rc-Transcript');
        if (transcriptContent) {
          const phrases = document.querySelectorAll('.rc-Phrase');
          if (phrases.length > 0) return true;
        }
      }

      // Check for reading content
      const readingContent = document.querySelector('.rc-CML, .rc-ReadingItem');
      if (readingContent) {
        const textContent = readingContent.textContent?.trim();
        return !!textContent && textContent.length > 100; // Ensure substantial content
      }

      return false;
    } catch (error) {
      console.error('Error checking transcript availability:', error);
      return false;
    }
  }

  /**
   * Get current video/reading information
   */
  static getCurrentVideoInfo(): CourseraVideo | null {
    try {
      if (!this.isCourseraCoursePage()) {
        return null;
      }

      // Extract title from page
      const titleElement = document.querySelector(
        'h1, [data-testid="video-title"], .video-title, .reading-title h1'
      );
      const title = titleElement?.textContent?.trim() || 'Coursera Content';

      // Extract content ID from URL
      const url = window.location.href;
      let contentId = 'unknown';

      const lectureMatch = url.match(/\/(?:lecture|quiz|exam|assignment-submission)\/([^/]+)/);
      const readingMatch = url.match(/\/(?:reading|supplement)\/([^/]+)/);

      if (lectureMatch) {
        contentId = lectureMatch[1];
      } else if (readingMatch) {
        contentId = readingMatch[1];
      }

      return {
        title,
        videoId: contentId,
        url,
        hasTranscript: this.isTranscriptAvailable(),
      };
    } catch (error) {
      console.error('Error getting Coursera content info:', error);
      return null;
    }
  }

  /**
   * Extract transcript from Coursera video or reading content
   */
  static async extractTranscript(): Promise<string> {
    try {
      // Wait for content to load
      await new Promise(resolve => setTimeout(resolve, 2000));

      if (this.getKind() === 'quiz') return await this.readAssessment();

      if (this.getKind() === 'article') {
        const address = location.href;
        for (let attempt = 0; attempt < 30; attempt++) {
          if (location.href !== address)
            throw new Error('The source changed while loading the reading.');
          const content = this.extractReadingContent();
          if (content) return content;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error(
          'The reading is still loading or unavailable. Retry when its content is visible.'
        );
      }

      // Try to extract video transcript first
      const transcriptEntries = this.extractTranscriptEntries();
      if (transcriptEntries.length > 0) {
        return this.formatTranscript(transcriptEntries);
      }

      if (this.getKind() === 'video') {
        const candidates = document.querySelectorAll<HTMLTrackElement | HTMLAnchorElement>(
          'video track[src], a[download], .rc-Downloads a[href], [data-testid*="download"] a[href]'
        );
        for (const element of candidates) {
          try {
            const url = new URL(
              element instanceof HTMLAnchorElement ? element.href : element.src,
              location.href
            );
            if (
              url.protocol !== 'https:' ||
              url.username ||
              url.password ||
              (!(element instanceof HTMLTrackElement) && !/\.(vtt|srt)$/i.test(url.pathname))
            )
              continue;
            const response = await fetch(url.href, {
              credentials: 'include',
              redirect: 'error',
              signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok) continue;
            const text = await response.text();
            if (text.length > 4_000_000) continue;
            const cues = parseCaptionFile(text);
            if (cues.length)
              return cues
                .map(cue => `[${formatTimestamp(cue.startSeconds)}] ${cue.text}`)
                .join('\n\n');
          } catch {
            // A missing or CORS-restricted track must not prevent another exposed track from working.
          }
        }
      }

      // If no video transcript, try to extract reading content
      const readingContent = this.extractReadingContent();
      if (readingContent) {
        return readingContent;
      }

      throw new Error('No transcript or reading content found. The content may not be available.');
    } catch (error) {
      console.error('Error extracting Coursera content:', error);
      throw new Error(`Failed to extract Coursera content: ${errorMessage(error)}`);
    }
  }

  /**
   * Extract transcript entries from the page
   */
  private static extractTranscriptEntries(): CourseraTranscriptEntry[] {
    const entries: CourseraTranscriptEntry[] = [];

    try {
      // Look for transcript phrases
      const phrases = document.querySelectorAll('.rc-Phrase');

      phrases.forEach(phrase => {
        const text = phrase.textContent?.trim();
        if (text) {
          // Try to find associated timestamp
          const paragraph = phrase.closest('.rc-Paragraph');
          const timestampElement = paragraph?.querySelector('.timestamp');
          const candidate = timestampElement?.textContent?.trim() || '';
          const timestamp = parseTimestamp(candidate) === null ? '' : candidate;

          entries.push({
            timestamp,
            text,
          });
        }
      });

      if (!entries.length)
        for (const video of document.querySelectorAll('video')) {
          for (const track of Array.from(video.textTracks || []))
            for (const cue of Array.from(track.cues || [])) {
              const text = (cue as VTTCue).text?.trim();
              if (text) entries.push({ timestamp: formatTimestamp(cue.startTime), text });
            }
        }

      // If no phrases found, try alternative selectors
      if (entries.length === 0) {
        const alternativePhrases = document.querySelectorAll('[data-cue]');
        alternativePhrases.forEach(phrase => {
          const text = phrase.textContent?.trim();
          if (text) {
            entries.push({
              timestamp: '',
              text,
            });
          }
        });
      }
    } catch (error) {
      console.error('Error extracting transcript entries:', error);
    }

    return entries;
  }

  /**
   * Extract reading content from Coursera reading sections
   */
  private static extractReadingContent(): string | null {
    try {
      // Look for reading content container
      const readingContainer = document.querySelector('.rc-CML, .rc-ReadingItem');
      if (!readingContainer) {
        return null;
      }
      const visibleText = readingContainer.textContent?.trim() || '';
      if (
        !visibleText ||
        /^loading[\s.…]*$/i.test(visibleText) ||
        readingContainer.closest('[aria-busy="true"]')
      )
        return null;

      // Get content info
      const contentInfo = this.getCurrentVideoInfo();
      const title = contentInfo?.title || 'Coursera Reading';

      // Format reading content
      let formattedContent = `# ${title}\n\n`;
      formattedContent += `**Source:** Coursera Reading\n`;
      formattedContent += `**URL:** ${window.location.href}\n`;
      formattedContent += `**Extracted:** ${new Date().toLocaleString()}\n\n`;
      formattedContent += `---\n\n`;

      // Extract and format the content
      const content = this.formatReadingContent(readingContainer);
      formattedContent += content;

      return formattedContent;
    } catch (error) {
      console.error('Error extracting reading content:', error);
      return null;
    }
  }

  /**
   * Format reading content with proper structure
   */
  private static formatReadingContent(container: Element): string {
    const render = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
      if (!(node instanceof Element)) return '';
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
      const tag = node.tagName.toLowerCase();
      if (
        ['script', 'style', 'input', 'textarea', 'select', 'button'].includes(tag) ||
        node.matches('[hidden],[aria-hidden="true"]')
      )
        return '';
      const text = [...node.childNodes].map(render).join('');
      if (/^h[1-6]$/.test(tag)) return `\n${'#'.repeat(Number(tag[1]))} ${text.trim()}\n\n`;
      if (tag === 'p' || tag === 'div' || tag === 'section') return `${text}\n\n`;
      if (tag === 'br') return '\n';
      if (tag === 'li') return `- ${text.trim()}\n`;
      if (tag === 'pre') return `\n\`\`\`\n${node.textContent}\n\`\`\`\n\n`;
      if (tag === 'strong' || tag === 'b') return `**${text}**`;
      if (tag === 'em' || tag === 'i') return `*${text}*`;
      if (tag === 'code') return `\`${text}\``;
      if (tag === 'a') {
        try {
          const url = new URL(node.getAttribute('href') || '', location.href);
          if (url.protocol === 'https:') return `[${text}](${url.href})`;
        } catch {
          /* Keep text. */
        }
      }
      if (tag === 'img') {
        try {
          const url = new URL(node.getAttribute('src') || '', location.href);
          if (url.protocol === 'https:')
            return `![${node.getAttribute('alt') || 'Image'}](${url.href})`;
        } catch {
          /* No image URL. */
        }
      }
      return text;
    };
    return render(container).trim();
  }

  /**
   * Format transcript entries into readable text
   */
  private static formatTranscript(entries: CourseraTranscriptEntry[]): string {
    if (entries.length === 0) {
      return '';
    }

    // Keep the same canonical format as every other extractor. Missing times stay absent.
    const formattedTranscript = entries
      .map(entry => (entry.timestamp ? `[${entry.timestamp}] ${entry.text}` : entry.text))
      .join('\n\n');

    return formattedTranscript;
  }

  /**
   * Extract course structure (for Coursera, this would be the course modules)
   */
  private static discovered: Array<{
    id: string;
    title: string;
    url: string;
    kind: 'video' | 'article' | 'quiz';
    section: string;
    available: boolean;
  }> = [];
  private static group = '';
  private static incomplete = false;

  static getKind(): 'video' | 'article' | 'quiz' | undefined {
    return /\/(quiz|exam|assignment-submission)\//.test(location.pathname)
      ? 'quiz'
      : /\/(reading|supplement)\//.test(location.pathname)
        ? 'article'
        : /\/lecture\//.test(location.pathname)
          ? 'video'
          : undefined;
  }
  static isLoading(): boolean {
    if (this.getKind() !== 'article') return false;
    const container = document.querySelector('.rc-CML, .rc-ReadingItem');
    const text = container?.textContent?.trim() || '';
    return (
      !document.querySelector('h1') ||
      !text ||
      /^loading[\s.…]*$/i.test(text) ||
      !!container?.closest('[aria-busy="true"]')
    );
  }
  static getSources(): string[] {
    const found = new Set<string>();
    for (const element of document.querySelectorAll<
      HTMLAnchorElement | HTMLSourceElement | HTMLVideoElement
    >(
      'video, video source, a[download], .rc-Downloads a[href], [data-testid*="download"] a[href]'
    )) {
      const value =
        element instanceof HTMLAnchorElement
          ? element.href
          : (element as HTMLVideoElement).currentSrc || (element as HTMLSourceElement).src;
      try {
        const url = new URL(value, location.href);
        if (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          /\.(mp4|m3u8)$/i.test(url.pathname)
        )
          found.add(url.href);
      } catch {
        /* Not a media URL. */
      }
    }
    return [...found];
  }
  static getAudioSources(): string[] {
    const found = new Set<string>();
    for (const element of document.querySelectorAll<
      HTMLAudioElement | HTMLSourceElement | HTMLAnchorElement
    >(
      'audio, audio source, a[download], .rc-Downloads a[href], [data-testid*="download"] a[href]'
    )) {
      const value =
        element instanceof HTMLAnchorElement
          ? element.href
          : element instanceof HTMLAudioElement
            ? element.currentSrc || element.src
            : element.src;
      try {
        const url = new URL(value, location.href);
        const type = element.getAttribute('type') || '';
        if (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          (/\.(mp3|m4a|webm)$/i.test(url.pathname) || type.startsWith('audio/'))
        )
          found.add(url.href);
      } catch {
        /* Not an exposed audio link. */
      }
    }
    return [...found];
  }
  private static readItems(root: Document): typeof CourseraExtractor.discovered {
    const prefix = location.pathname.match(/^\/learn\/[^/]+/)?.[0];
    if (!prefix) return [];
    const found: typeof CourseraExtractor.discovered = [];
    for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      let url: URL;
      try {
        url = new URL(link.getAttribute('href')!, location.href);
      } catch {
        continue;
      }
      if (url.origin !== location.origin || !url.pathname.startsWith(`${prefix}/`)) continue;
      const match = url.pathname
        .slice(prefix.length)
        .match(/^\/(lecture|reading|supplement|quiz|exam|assignment-submission)\/([^/]+)(?:\/|$)/);
      if (!match || found.some(item => item.id === `${match[1]}:${match[2]}`)) continue;
      const title = (
        link.querySelector('[data-testid="item-title"], .item-title') || link
      ).textContent?.trim();
      if (!title) continue;
      let section = '';
      for (
        let container = link.parentElement;
        container && container !== root.body;
        container = container.parentElement
      ) {
        const heading = container.querySelector('h2,h3,h4');
        if (heading?.textContent?.trim()) {
          section = heading.textContent.trim();
          break;
        }
      }
      section ||= 'Course items';
      url.search = '';
      url.hash = '';
      found.push({
        id: `${match[1]}:${match[2]}`,
        title,
        url: url.href,
        section,
        kind:
          match[1] === 'lecture'
            ? 'video'
            : match[1] === 'reading' || match[1] === 'supplement'
              ? 'article'
              : 'quiz',
        available:
          link.getAttribute('aria-disabled') !== 'true' && !link.closest('[data-locked="true"]'),
      });
    }
    return found;
  }
  /** Follow only course-outline URLs that the signed-in page actually exposes. */
  static async loadAllItems(signal: AbortSignal): Promise<void> {
    const prefix = location.pathname.match(/^\/learn\/[^/]+/)?.[0];
    if (!prefix) return;
    this.group = prefix;
    this.discovered = [];
    this.incomplete = false;
    let expanded = false;
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      '.rc-Module button[aria-expanded="false"], [data-testid*="syllabus"] button[aria-expanded="false"], nav[aria-label*="course" i] button[aria-expanded="false"], h3 button[aria-expanded="false"]'
    )) {
      signal.throwIfAborted();
      button.click();
      expanded = true;
    }
    if (expanded) {
      await new Promise<void>((resolve, reject) => {
        const stop = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', stop);
          resolve();
        }, 500);
        signal.addEventListener('abort', stop, { once: true });
      });
      signal.throwIfAborted();
    }
    const merge = (items: typeof CourseraExtractor.discovered) => {
      for (const item of items)
        if (!this.discovered.some(value => value.id === item.id)) this.discovered.push(item);
    };
    merge(this.readItems(document));
    const pages = new Set<string>();
    const readPages = (root: Document) => {
      for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        try {
          const url = new URL(link.getAttribute('href')!, location.href);
          if (
            url.origin === location.origin &&
            (url.pathname === `${prefix}/home` || url.pathname.startsWith(`${prefix}/home/`))
          ) {
            url.hash = '';
            url.search = '';
            pages.add(url.href);
          }
        } catch {
          /* Ignore unrelated links. */
        }
      }
    };
    readPages(document);
    const visited = new Set<string>();
    while ([...pages].some(url => !visited.has(url)) && visited.size < 100) {
      signal.throwIfAborted();
      const url = [...pages].find(value => !visited.has(value))!;
      visited.add(url);
      try {
        const response = await fetch(url, { credentials: 'include', redirect: 'error', signal });
        if (!response.ok) throw new Error('Outline unavailable.');
        const html = await response.text();
        if (html.length > 8_000_000) throw new Error('Outline is too large.');
        const root = new DOMParser().parseFromString(html, 'text/html');
        merge(this.readItems(root));
        readPages(root);
      } catch (err) {
        signal.throwIfAborted();
        this.incomplete = true;
      }
    }
    if (pages.size > visited.size || !this.discovered.length) this.incomplete = true;
    if (location.pathname.match(/^\/learn\/[^/]+/)?.[0] !== prefix)
      throw new Error('The source changed while reading the course outline.');
  }
  static extractCourseStructure(): any {
    if (!this.isCourseraCoursePage()) return null;
    const prefix = location.pathname.match(/^\/learn\/[^/]+/)?.[0] || '';
    const items = [...(this.group === prefix ? this.discovered : [])];
    for (const item of this.readItems(document))
      if (!items.some(value => value.id === item.id)) items.push(item);
    const current = this.getCurrentVideoInfo();
    const kind = this.getKind();
    if (
      current &&
      kind &&
      !items.some(item => lectureId(item.url, '') === lectureId(current.url, ''))
    )
      items.push({
        id: current.videoId,
        title: current.title,
        url: current.url,
        kind,
        section: 'Current item',
        available: true,
      });
    const sections = [...new Set(items.map(item => item.section))].map(title => ({
      title,
      lectures: items
        .filter(item => item.section === title)
        .map(item => ({ ...item, isCompleted: false, duration: 'Unknown' })),
    }));
    return {
      title:
        document
          .querySelector('[data-testid="course-title"], .course-title')
          ?.textContent?.trim() ||
        [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
          .find(link => {
            try {
              return new URL(link.href).pathname === `${prefix}/home/welcome`;
            } catch {
              return false;
            }
          })
          ?.textContent?.trim() ||
        document.querySelector('h1')?.textContent?.trim() ||
        'Coursera',
      instructor: '',
      sections,
      currentLecture: current,
      totalItems: items.length,
      loadedItems: items.length,
      notice:
        this.incomplete || items.length <= 1
          ? 'Only discovered items are listed. Open the course outline and retry the list if modules are missing.'
          : 'Completed practice quizzes can reopen with Try again. Graded tests export only questions already open in your session; nothing is submitted.',
    };
  }
  private static async readAssessment(): Promise<string> {
    try {
      return this.extractAssessment();
    } catch {
      // Only reopen completed practice quizzes. Do not start graded or unopened assessments.
    }
    const address = lectureId(location.href, '');
    const heading = document.querySelector('h1')?.textContent?.trim() || '';
    const buttons = () =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
        button => !button.disabled && !button.closest('[hidden],[aria-hidden="true"]')
      );
    const retry = buttons().find(button => button.textContent?.trim() === 'Try again');
    const resume = buttons().find(button => button.textContent?.trim() === 'Resume assignment');
    const completed = buttons().some(button => button.textContent?.trim() === 'View feedback');
    if (
      !/^Practice Quiz\b/i.test(heading) ||
      !/\/practice-quiz(?:-|$)/i.test(new URL(address).pathname) ||
      (!resume && (!completed || !retry))
    )
      return this.extractAssessment();
    (resume || retry)!.click();
    let confirmed = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (lectureId(location.href, '') !== address)
        throw new Error('The source changed while opening practice questions.');
      const title = [...document.querySelectorAll('h1,h2,h3')].find(
        element => element.textContent?.trim() === 'Start new attempt?'
      );
      const dialog = title?.closest('[role="dialog"],dialog') || title?.parentElement;
      const proceed =
        dialog &&
        [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(
          button => button.textContent?.trim() === 'Continue' && !button.disabled
        );
      if (
        !resume &&
        !confirmed &&
        proceed &&
        /replace your previous submission/i.test(dialog?.textContent || '')
      ) {
        proceed.click();
        confirmed = true;
      }
      try {
        return this.extractAssessment();
      } catch {
        /* Wait for questions, never select or submit. */
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Practice questions did not load. Retry when the questions are visible.');
  }
  private static extractAssessment(): string {
    const root = document.querySelector('main') || document.body;
    const questions = [
      ...root.querySelectorAll(
        '.rc-FormPartsQuestion, [data-testid="question"], [data-testid="assessment-question"], [role="radiogroup"]'
      ),
    ].filter(element => {
      if (element.closest('[hidden], [aria-hidden="true"]')) return false;
      for (let parent: Element | null = element; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return !element.parentElement?.closest(
        '.rc-FormPartsQuestion, [data-testid="question"], [data-testid="assessment-question"], [role="radiogroup"]'
      );
    });
    if (!questions.length)
      throw new Error(
        'No visible test questions are available. Open an authorized attempt manually; the extension will not start or submit it.'
      );
    const title = this.getCurrentVideoInfo()?.title || 'Assessment';
    const parts = questions.map((question, index) => {
      const prompt =
        (question.getAttribute('aria-labelledby') || '')
          .split(/\s+/)
          .filter(Boolean)
          .map(id => document.getElementById(id)?.textContent?.trim() || '')
          .join(' ')
          .trim() ||
        question.getAttribute('aria-label')?.trim() ||
        '';
      const copy = question.cloneNode(true) as Element;
      const originals = question.querySelectorAll('*');
      const copies = copy.querySelectorAll('*');
      originals.forEach((element, position) => {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') copies[position].remove();
      });
      copy
        .querySelectorAll('script,style,button,input,textarea,select,[hidden],[aria-hidden="true"]')
        .forEach(element => element.remove());
      copy.querySelectorAll('label,[role="radio"],[role="checkbox"]').forEach(element => {
        element.insertAdjacentText('afterend', '\n');
      });
      const text = copy.textContent?.trim() || '';
      return `## Question ${index + 1}\n\n${prompt && !text.includes(prompt) ? `${prompt}\n\n` : ''}${text || 'Question text unavailable.'}`;
    });
    return `# ${title}\n\nSource: ${location.href}\n\nVisible-question snapshot only; this is not an interactive test or complete question bank.\n\n${parts.join('\n\n')}`;
  }

  /**
   * Test all selectors for debugging
   */
  static testAllSelectors(): void {
    log.debug('🎯 Testing Coursera selectors...');

    const selectors = [
      // Video transcript selectors
      '[role="tabpanel"]',
      '.rc-Transcript',
      '.rc-Phrase',
      '[data-cue]',
      '.timestamp',
      '.rc-Paragraph',
      // Reading content selectors
      '.rc-CML',
      '.rc-ReadingItem',
      '.reading-title',
      '[data-testid="cml-viewer"]',
      '.css-g2bbpm',
      'h1, h2, h3, h4, h5, h6',
      'p[data-text-variant="body1"]',
      '.rc-CodeBlock',
      '.monaco-editor',
    ];

    selectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      log.debug(`🎯 Selector "${selector}": ${elements.length} elements found`);
      if (elements.length > 0) {
        elements.forEach((el, i) => {
          const text = el.textContent?.substring(0, 50) || '';
          log.debug(`  Element ${i + 1}: "${text}..."`);
        });
      }
    });
  }
}
