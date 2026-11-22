import type { StreamInfo } from './stream-discovery';
import type { AdaptiveInfo } from './playback-session';
export const PROTOCOL_VERSION = 4;

export interface VideoDownloadContext {
  url: string;
  title: string;
  sources: string[];
  protected: boolean;
  hasPlayer?: boolean;
  loading?: boolean;
  kind?: 'video' | 'quiz' | 'article';
  streams?: StreamInfo[];
  unavailable?: string;
  adaptive?: AdaptiveInfo;
  diagnostics?: string;
  thumbnail?: string;
}

/** Observe only resource URLs already requested by this lecture page. */
export function createHlsDiscovery(): () => string[] {
  let page = location.href.split('#')[0];
  const found = new Set<string>();
  const add = (name: string, direct = false) => {
    try {
      const url = new URL(name, location.href);
      if (
        url.protocol === 'https:' &&
        (/\.m3u8$/i.test(url.pathname) || (direct && /\.mp4$/i.test(url.pathname)))
      )
        found.add(url.href);
    } catch {
      /* Not a URL. */
    }
  };
  const sync = () => {
    const next = location.href.split('#')[0];
    if (next !== page) {
      found.clear();
      page = next;
    }
  };
  // Buffered entries are useful after a full page load. Refreshing the course
  // before opening the downloader avoids historical resources from older SPAs.
  for (const entry of performance.getEntriesByType('resource')) add(entry.name);
  if (typeof PerformanceObserver !== 'undefined') {
    new PerformanceObserver(list => {
      sync();
      for (const entry of list.getEntries()) add(entry.name);
    }).observe({ type: 'resource', buffered: false });
  }
  return () => {
    sync();
    for (const video of document.querySelectorAll('video')) {
      add(video.currentSrc, true);
      add(video.src, true);
      for (const source of video.querySelectorAll('source')) add(source.src, true);
    }
    return [...found].slice(-20).reverse();
  };
}
