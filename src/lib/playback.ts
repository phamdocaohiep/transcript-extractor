import type { VideoDownloadContext } from './hls-discovery';
import { lectureId } from './collection';
import { selectStreams } from './stream-discovery';

export class MissingStreamError extends Error {}

/** Prime a lazy player, then reload once if its stream is still unavailable. */
export async function resolvePlayback(
  url: string,
  read: () => Promise<VideoDownloadContext>,
  prime: () => Promise<unknown>,
  reload: () => Promise<unknown>,
  signal: AbortSignal,
  retrying: () => void
): Promise<VideoDownloadContext> {
  let last: VideoDownloadContext | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) {
      retrying();
      await reload();
    }
    for (let poll = 0; poll < 20; poll++) {
      signal.throwIfAborted();
      let next: VideoDownloadContext | undefined;
      try {
        next = await read();
      } catch {
        /* A content script may still be loading. */
      }
      if (next && lectureId(next.url, '') === lectureId(url, '')) {
        last = next;
        if (next.unavailable) throw new Error(next.unavailable);
        if (next.protected || next.sources.length || selectStreams(next.streams || [])) return next;
        if (
          !next.loading &&
          next.hasPlayer === false &&
          (next.kind === 'quiz' || next.kind === 'article')
        )
          return next;
        await prime().catch(() => undefined);
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, 500);
        function done() {
          signal.removeEventListener('abort', cancel);
          resolve();
        }
        function cancel() {
          clearTimeout(timer);
          reject(signal.reason);
        }
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      });
    }
  }
  // An absent element during hydration is not evidence that a video is absent.
  if (
    last?.hasPlayer === false &&
    !last.loading &&
    last.kind !== 'video' &&
    !/\.udemy\.com\/course\/[^/]+\/learn\/lecture\//.test(url)
  )
    return last;
  if (last?.streams)
    throw new MissingStreamError(
      'The YouTube player did not expose a complete downloadable video and audio pair after reloading.'
    );
  throw new MissingStreamError('The player has no supported HLS or MP4 stream after reloading.');
}

export function canRetryDownload(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  return (
    error instanceof TypeError ||
    (error instanceof Error &&
      /HTTP (401|403|408|429|5\d\d)|expired|network|fetch|timeout|connect|incomplete|truncated|byte range|older extension script/i.test(
        error.message
      ))
  );
}
