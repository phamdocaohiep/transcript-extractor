/** Finite HLS with clear or identity AES-128 segments. DRM is unsupported. */
export interface HlsKey {
  url: string;
  iv: Uint8Array;
}
export interface HlsPart {
  url: string;
  range?: { start: number; length: number };
  key?: HlsKey;
}
export interface HlsVariant {
  url: string;
  bandwidth: number;
  label: string;
  externalAudio: boolean;
  height?: number;
}
export type HlsPlaylist =
  | { kind: 'master'; variants: HlsVariant[] }
  | { kind: 'media'; parts: HlsPart[]; extension: 'ts' | 'mp4'; duration: number };
export type HlsPlan = Extract<HlsPlaylist, { kind: 'media' }> & { playlistUrl: string };

export function hlsUrl(value: string, base?: string): string {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Video downloads require an HTTPS URL without embedded credentials.');
  }
  return url.href;
}
function attributes(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  const value = line.slice(line.indexOf(':') + 1);
  for (const match of value.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    result[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return result;
}
function byteRange(value: string, previous?: HlsPart): NonNullable<HlsPart['range']> {
  const match = value.match(/^(\d+)(?:@(\d+))?$/);
  if (!match) throw new Error('Invalid HLS byte range.');
  const length = Number(match[1]);
  const start =
    match[2] === undefined
      ? previous?.range && previous.range.start + previous.range.length
      : Number(match[2]);
  if (
    start === undefined ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    !Number.isSafeInteger(start + length)
  ) {
    throw new Error('Invalid or ambiguous HLS byte range.');
  }
  return { start, length };
}
function keyIv(value: string | undefined, sequence: number): Uint8Array {
  if (value) {
    if (!/^0[xX][\da-fA-F]{32}$/.test(value)) throw new Error('Invalid AES-128 HLS IV.');
    return Uint8Array.from(value.slice(2).match(/../g)!, byte => parseInt(byte, 16));
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new Error('Invalid HLS media sequence.');
  const iv = new Uint8Array(16);
  let remaining = BigInt(sequence);
  for (let i = 15; i >= 0; i--) {
    iv[i] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  return iv;
}
function parseKey(line: string, base: string): { url: string; iv?: string } | undefined {
  const a = attributes(line);
  if (a.METHOD === 'NONE') return undefined;
  if (a.METHOD !== 'AES-128' || (a.KEYFORMAT && a.KEYFORMAT !== 'identity'))
    throw new Error('This HLS encryption method uses DRM or is not supported.');
  if (!a.URI) throw new Error('Missing AES-128 HLS key URL.');
  if (a.IV) keyIv(a.IV, 0);
  return { url: hlsUrl(a.URI, base), iv: a.IV };
}
export function parseHls(text: string, base: string): HlsPlaylist {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('This URL did not return an HLS playlist.');
  if (lines.length > 50000) throw new Error('This playlist is too large.');
  for (const line of lines) {
    if (line.startsWith('#EXT-X-SESSION-KEY:')) parseKey(line, base);
    if (
      line === '#EXT-X-DISCONTINUITY' ||
      line.startsWith('#EXT-X-GAP') ||
      line.startsWith('#EXT-X-DEFINE:')
    ) {
      throw new Error(
        'This HLS stream needs a media remuxer and is not supported by this downloader.'
      );
    }
  }
  const externalAudio = new Set(
    lines
      .filter(l => l.startsWith('#EXT-X-MEDIA:'))
      .map(attributes)
      .filter(a => a.TYPE === 'AUDIO' && a.URI)
      .map(a => a['GROUP-ID'])
  );
  const variants: HlsVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = attributes(lines[i]);
    const uri = lines[i + 1];
    if (!uri || uri.startsWith('#')) throw new Error('Missing HLS variant URL.');
    variants.push({
      url: hlsUrl(uri, base),
      bandwidth: Number(a.BANDWIDTH) || 0,
      label: a.RESOLUTION || `${Math.round((Number(a.BANDWIDTH) || 0) / 1000)} kbps`,
      externalAudio: externalAudio.has(a.AUDIO),
      ...(a.RESOLUTION?.match(/x(\d+)$/) ? { height: Number(a.RESOLUTION.split('x')[1]) } : {}),
    });
  }
  if (variants.length) return { kind: 'master', variants };
  if (!lines.includes('#EXT-X-ENDLIST'))
    throw new Error('Live or unfinished HLS streams are not supported.');
  const parts: HlsPart[] = [];
  let map: HlsPart | undefined;
  let pendingRange: string | undefined;
  let duration = 0;
  let segmentCount = 0;
  let pendingSegment = false;
  const sequenceLine = lines.find(line => line.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
  const sequenceValue = sequenceLine?.slice('#EXT-X-MEDIA-SEQUENCE:'.length) ?? '0';
  if (!/^\d+$/.test(sequenceValue) || !Number.isSafeInteger(Number(sequenceValue)))
    throw new Error('Invalid HLS media sequence.');
  const mediaSequence = Number(sequenceValue);
  let activeKey: ReturnType<typeof parseKey>;
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-KEY:')) {
      activeKey = parseKey(line, base);
    } else if (line.startsWith('#EXT-X-MAP:')) {
      if (activeKey && !activeKey.iv)
        throw new Error('Encrypted HLS initialization sections require an explicit IV.');
      const a = attributes(line);
      if (!a.URI) throw new Error('Missing HLS initialization URL.');
      const next = {
        url: hlsUrl(a.URI, base),
        ...(a.BYTERANGE ? { range: byteRange(a.BYTERANGE) } : {}),
        ...(activeKey
          ? { key: { url: activeKey.url, iv: keyIv(activeKey.iv, mediaSequence) } }
          : {}),
      };
      if (map && JSON.stringify(map) !== JSON.stringify(next))
        throw new Error('Changing HLS initialization sections require a remuxer.');
      if (!map) {
        if (parts.length) throw new Error('HLS initialization section appears after media.');
        map = next;
        parts.push(map);
      }
    } else if (line.startsWith('#EXTINF:')) {
      const seconds = Number(line.slice(8).split(',')[0]);
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid HLS duration.');
      duration += seconds;
      pendingSegment = true;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice(17);
    } else if (!line.startsWith('#')) {
      if (!pendingSegment) throw new Error('Missing HLS segment duration.');
      const url = hlsUrl(line, base);
      const previous = parts.at(-1);
      const range = pendingRange
        ? byteRange(pendingRange, previous?.url === url ? previous : undefined)
        : undefined;
      const sequence = mediaSequence + segmentCount;
      if (!Number.isSafeInteger(sequence)) throw new Error('Invalid HLS media sequence.');
      parts.push({
        url,
        ...(range ? { range } : {}),
        ...(activeKey ? { key: { url: activeKey.url, iv: keyIv(activeKey.iv, sequence) } } : {}),
      });
      pendingRange = undefined;
      pendingSegment = false;
      segmentCount++;
    }
  }
  if (!segmentCount || pendingSegment || pendingRange)
    throw new Error('This HLS playlist has missing media segments.');
  return { kind: 'media', parts, extension: map ? 'mp4' : 'ts', duration };
}

export async function resolveHls(
  url: string,
  readText: (url: string) => Promise<string>,
  maxHeight?: number
): Promise<HlsPlan> {
  const visited = new Set<string>();
  let current = hlsUrl(url);
  for (let depth = 0; depth < 5; depth++) {
    if (visited.has(current)) throw new Error('Circular HLS playlist reference.');
    visited.add(current);
    const playlist = parseHls(await readText(current), current);
    if (playlist.kind === 'media') return { ...playlist, playlistUrl: current };
    const variant = playlist.variants
      .filter(v => !v.externalAudio && (!maxHeight || !v.height || v.height <= maxHeight))
      .sort(
        (a, b) => (maxHeight ? (b.height || 0) - (a.height || 0) : 0) || b.bandwidth - a.bandwidth
      )[0];
    if (!variant)
      throw new Error(
        maxHeight
          ? 'No supported video is available at or below the selected resolution.'
          : 'This stream has separate audio and video tracks. Combining them requires a media remuxer.'
      );
    current = variant.url;
  }
  throw new Error('Too many nested HLS playlists.');
}

/** Reads one segment at a time, with a hard bound even when Content-Length is absent. */
export async function readHlsResponse(
  response: Response,
  limit: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  if (!response.ok)
    throw new Error(
      `Video server returned HTTP ${response.status}. Refresh the lecture if its link has expired.`
    );
  if (!response.body) throw new Error('The video server returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('A video segment exceeded the 128 MB safety limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export async function writeHls(
  plan: HlsPlan,
  fetchPart: (part: HlsPart, signal: AbortSignal) => Promise<Response>,
  fetchKey: (url: string, signal: AbortSignal) => Promise<Response>,
  write: (bytes: Uint8Array) => Promise<void>,
  signal: AbortSignal,
  progress: (completed: number, total: number, bytes: number) => void
): Promise<void> {
  let bytes = 0;
  const keys = new Map<string, CryptoKey>();
  for (const [index, part] of plan.parts.entries()) {
    signal.throwIfAborted();
    const response = await fetchPart(part, signal);
    if (part.range) {
      const expected = `bytes ${part.range.start}-${part.range.start + part.range.length - 1}/`;
      if (response.status !== 206 || !response.headers.get('content-range')?.startsWith(expected)) {
        await response.body?.cancel();
        throw new Error('The server did not honor the requested video byte range.');
      }
    }
    let data = await readHlsResponse(response, 128 * 1024 * 1024, signal);
    if (!data.length || (part.range && data.length !== part.range.length))
      throw new Error('An HLS segment is empty or truncated.');
    if (part.key) {
      let key = keys.get(part.key.url);
      if (!key) {
        const keyBytes = await readHlsResponse(await fetchKey(part.key.url, signal), 17, signal);
        if (keyBytes.length !== 16) throw new Error('Invalid AES-128 HLS key length.');
        key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, 'AES-CBC', false, [
          'decrypt',
        ]);
        keys.set(part.key.url, key);
      }
      try {
        data = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: 'AES-CBC', iv: part.key.iv as BufferSource },
            key,
            data as BufferSource
          )
        );
      } catch {
        throw new Error(
          'Could not decrypt an AES-128 HLS segment. The key or stream may have expired.'
        );
      }
    }
    if (plan.extension === 'ts' && (data[0] !== 0x47 || data.length % 188 !== 0)) {
      throw new Error('This stream is not MPEG-TS video. It may be audio-only or protected.');
    }
    if (
      plan.extension === 'mp4' &&
      !['ftyp', 'styp', 'sidx', 'moof'].includes(new TextDecoder().decode(data.slice(4, 8)))
    ) {
      throw new Error('The server did not return a supported fragmented MP4 segment.');
    }
    signal.throwIfAborted();
    await write(data);
    bytes += data.length;
    progress(index + 1, plan.parts.length, bytes);
  }
}

export function safeVideoName(value: string): string {
  // Filesystem control characters must be replaced along with path separators.
  const name = value
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, '_')
    .replace(/^\.+|[. ]+$/g, '')
    .trim()
    .slice(0, 100);
  return !name || /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(name) ? `lecture_${name}` : name;
}
