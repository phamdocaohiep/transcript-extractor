/** Canonical group URL, shared by the library and legacy collections. */
export function groupKey(value: string | undefined): string {
  if (!value) return 'unknown';
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
      const playlist = url.searchParams.get('list');
      if (playlist) return `https://www.youtube.com/playlist?list=${encodeURIComponent(playlist)}`;
      const video = host === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v');
      if (video) return `https://www.youtube.com/watch?v=${encodeURIComponent(video)}`;
    }
    const prefix = host === 'coursera.org' || host.endsWith('.coursera.org') ? 'learn' : 'course';
    const pattern = prefix === 'learn' ? /^\/learn\/([^/]+)/ : /^\/course\/([^/]+)/;
    const match = url.pathname.match(pattern);
    return match ? `${url.origin}/${prefix}/${match[1]}` : `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}
