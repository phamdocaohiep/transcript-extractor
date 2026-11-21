import type { StreamInfo } from './stream-discovery';

type FetchPart = (url: string, headers: HeadersInit) => Promise<Response>;

/** Fetch finite CDN files in bounded ranges and reject partial or unrelated responses. */
export async function writeStream(
  stream: StreamInfo,
  fetchPart: FetchPart,
  write: (bytes: Uint8Array) => Promise<void>,
  signal: AbortSignal,
  progress: (bytes: number) => void,
  chunkSize = 4 * 1024 * 1024
): Promise<void> {
  let offset = 0;
  let total = stream.size;
  let first = new Uint8Array(0);
  let validated = false;
  do {
    signal.throwIfAborted();
    const end = total ? Math.min(offset + chunkSize, total) - 1 : offset + chunkSize - 1;
    const url = new URL(stream.url);
    const signed =
      `${url.searchParams.get('sparams') || ''},${url.searchParams.get('lsparams') || ''}`.split(
        ','
      );
    if (url.hostname.endsWith('.googlevideo.com') && !signed.includes('range'))
      url.searchParams.set('range', `${offset}-${end}`);
    const response = await fetchPart(url.href, { Range: `bytes=${offset}-${end}` });
    if (!response.ok)
      throw new Error(
        `Video server returned HTTP ${response.status}. Refresh the video in Chrome and retry.`
      );
    if (!response.body) throw new Error('The video server returned an empty response.');
    const range = response.headers.get('Content-Range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
    if (!total && !range && url.hostname.endsWith('.googlevideo.com'))
      throw new Error('The video server did not report the complete file size.');
    if (response.status === 206 && !range)
      throw new Error('The video server returned an invalid byte range.');
    if (range) {
      const [, start, finish, length] = range.map(Number);
      if (
        ![start, finish, length].every(Number.isSafeInteger) ||
        start !== offset ||
        finish < start ||
        finish > end ||
        length <= finish ||
        (total && total !== length)
      )
        throw new Error('The video server returned a different byte range or file size.');
      total = length;
    } else if (offset && response.status !== 200) {
      throw new Error('The video server did not honor the requested byte range.');
    }
    const reader = response.body.getReader();
    let received = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        received += value.length;
        if (
          (range && received > Number(range[2]) - offset + 1) ||
          (total && offset + received > total)
        )
          throw new Error('The video response exceeds its declared size.');
        if (!validated) {
          const next = new Uint8Array(first.length + value.length);
          next.set(first);
          next.set(value, first.length);
          first = next;
          if (first.length < 12) continue;
          const mp4 = new TextDecoder().decode(first.slice(4, 8)) === 'ftyp';
          const webm =
            first[0] === 0x1a && first[1] === 0x45 && first[2] === 0xdf && first[3] === 0xa3;
          if (stream.mimeType.includes('/mp4') ? !mp4 : !webm)
            throw new Error('The server did not return the requested media file.');
          await write(first);
          first = new Uint8Array(0);
          validated = true;
        } else await write(value);
        progress(offset + received);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (!received || (range && received !== Number(range[2]) - offset + 1))
      throw new Error('The video response was incomplete.');
    // A 200 response without Content-Range may be a full file or a CDN query
    // range. Only accept a partial body when its byte count exactly matches
    // the requested range and the full size is known.
    if (!range && total && offset + received < total && received !== end - offset + 1)
      throw new Error('The video server returned a truncated file.');
    if (!range && offset && received > end - offset + 1)
      throw new Error('The video server repeated the full file instead of the requested range.');
    offset += received;
    if (!total && !range) break;
  } while (offset < total!);
  if (!validated || (total && offset !== total))
    throw new Error('The downloaded media file is incomplete.');
}
