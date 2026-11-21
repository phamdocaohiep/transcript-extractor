import { describe, expect, it, vi } from 'vitest';
import {
  hlsUrl,
  parseHls,
  resolveHls,
  safeVideoName,
  writeHls,
  readHlsResponse,
  type HlsPlan,
} from './hls';
const base = 'https://cdn.example.test/course/index.m3u8?token=signed';
const media = '#EXTM3U\n#EXTINF:5,\na.ts\n#EXTINF:4,\nb.ts\n#EXT-X-ENDLIST';
const signal = () => new AbortController().signal;
const ts = () => {
  const data = new Uint8Array(188);
  data[0] = 0x47;
  return data;
};
function plan(text = media): HlsPlan {
  const parsed = parseHls(text, base);
  if (parsed.kind !== 'media') throw new Error('Expected media');
  return { ...parsed, playlistUrl: base };
}
describe('HLS playlists', () => {
  it('resolves relative and signed segment URLs without changing their query', () => {
    expect(plan().parts.map(p => p.url)).toEqual([
      'https://cdn.example.test/course/a.ts',
      'https://cdn.example.test/course/b.ts',
    ]);
    expect(plan(media.replace('a.ts', '../a.ts?key=abc%2B123')).parts[0].url).toBe(
      'https://cdn.example.test/a.ts?key=abc%2B123'
    );
  });
  it('selects the highest bandwidth variant with included audio', async () => {
    const read = vi.fn(async (url: string) =>
      url === base
        ? `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English, original",URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=500,RESOLUTION=640x360
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000,AUDIO="audio"
silent.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720
high.m3u8`
        : media
    );
    expect((await resolveHls(base, read)).playlistUrl).toBe(
      'https://cdn.example.test/course/high.m3u8'
    );
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('refuses separate audio rather than silently downloading a muted video', async () => {
    await expect(
      resolveHls(
        base,
        async () =>
          '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="a.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="a"\nv.m3u8'
      )
    ).rejects.toThrow('separate audio');
  });
  it('tracks AES-128 keys, sequence IVs, key rotation and clear segments', () => {
    const result = plan(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:256
#EXT-X-KEY:METHOD=AES-128,URI="first.key"
#EXTINF:2,
a.ts
#EXT-X-KEY:METHOD=AES-128,URI="second.key",IV=0x0000000000000000000000000000000F
#EXTINF:2,
b.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:2,
c.ts
#EXT-X-ENDLIST`);
    expect(result.parts[0].key?.url).toBe('https://cdn.example.test/course/first.key');
    expect(result.parts[0].key?.iv[14]).toBe(1);
    expect(result.parts[1].key?.iv[15]).toBe(15);
    expect(result.parts[2].key).toBeUndefined();
  });
  it('accepts clear streams and rejects DRM encryption', () => {
    expect(plan(media.replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=NONE')).extension).toBe('ts');
    expect(() => parseHls('#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="key"', base)).toThrow(
      'DRM'
    );
    expect(() =>
      plan(
        media.replace(
          '#EXTM3U',
          '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,KEYFORMAT="com.apple.streamingkeydelivery",URI="key"'
        )
      )
    ).toThrow('DRM');
  });
  it('supports initialization segments and explicit/implicit byte ranges', () => {
    const result = plan(`#EXTM3U
#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"
#EXTINF:3,
#EXT-X-BYTERANGE:20@100
video.mp4
#EXTINF:2,
#EXT-X-BYTERANGE:30
video.mp4
#EXT-X-ENDLIST`);
    expect(result.extension).toBe('mp4');
    expect(result.parts.map(p => p.range)).toEqual([
      { start: 0, length: 100 },
      { start: 100, length: 20 },
      { start: 120, length: 30 },
    ]);
  });
  it('rejects an implicit byte offset for a different resource', () => {
    expect(() =>
      plan(
        '#EXTM3U\n#EXTINF:2,\n#EXT-X-BYTERANGE:20@0\na.ts\n#EXTINF:2,\n#EXT-X-BYTERANGE:20\nb.ts\n#EXT-X-ENDLIST'
      )
    ).toThrow('ambiguous');
  });
  it.each([
    ['<html>Sign in</html>', 'HLS playlist'],
    [media.replace('#EXT-X-ENDLIST', ''), 'Live'],
    [media.replace('a.ts', '#EXT-X-DISCONTINUITY\na.ts'), 'remuxer'],
    [media.replace('b.ts', 'file:///private/data'), 'HTTPS'],
    ['#EXTM3U\n#EXT-X-ENDLIST', 'missing media'],
  ])('rejects unsupported or invalid input', (text, reason) =>
    expect(() => parseHls(text, base)).toThrow(reason)
  );
  it('detects circular masters', async () => {
    await expect(
      resolveHls(base, async () => `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\n${base}`)
    ).rejects.toThrow('Circular');
  });
});
describe('video writing', () => {
  it('decrypts AES-128 segments with the Chrome crypto API and fetches a shared key once', async () => {
    const encrypted = plan(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:2,
a.ts
#EXTINF:2,
b.ts
#EXT-X-ENDLIST`);
    const rawKey = new Uint8Array(16).fill(9);
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, ['encrypt']);
    const fetchPart = vi.fn(async (part: HlsPlan['parts'][number]) => {
      const encryptedBytes = await crypto.subtle.encrypt(
        { name: 'AES-CBC', iv: part.key!.iv },
        key,
        ts()
      );
      return new Response(encryptedBytes);
    });
    const fetchKey = vi.fn(async () => new Response(rawKey));
    const written: Uint8Array[] = [];
    await writeHls(
      encrypted,
      fetchPart,
      fetchKey,
      async bytes => {
        written.push(bytes);
      },
      signal(),
      vi.fn()
    );
    expect(fetchKey).toHaveBeenCalledOnce();
    expect(written).toHaveLength(2);
    expect(written[0]).toEqual(ts());
    expect(written[1]).toEqual(ts());
  });
  it('rejects invalid key data before writing media', async () => {
    const encrypted = plan(
      media.replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"')
    );
    const write = vi.fn();
    await expect(
      writeHls(
        encrypted,
        async () => new Response(ts()),
        async () => new Response(new Uint8Array(15)),
        write,
        signal(),
        vi.fn()
      )
    ).rejects.toThrow('key length');
    expect(write).not.toHaveBeenCalled();
  });
  it('writes media in playlist order and reports bytes after writes succeed', async () => {
    const fetchPart = vi.fn(async () => new Response(ts()));
    const write = vi.fn(async () => undefined);
    const progress = vi.fn();
    await writeHls(plan(), fetchPart, vi.fn(), write, signal(), progress);
    expect(fetchPart.mock.calls).toHaveLength(2);
    expect(write).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenLastCalledWith(2, 2, 376);
  });
  it('does not append HTML error responses to a video', async () => {
    const write = vi.fn();
    await expect(
      writeHls(
        plan(),
        async () => new Response('<html>login</html>'),
        vi.fn(),
        write,
        signal(),
        vi.fn()
      )
    ).rejects.toThrow('not MPEG-TS');
    expect(write).not.toHaveBeenCalled();
  });
  it('preserves server errors and does not write failed segments', async () => {
    const write = vi.fn();
    await expect(
      writeHls(
        plan(),
        async () => new Response('Forbidden', { status: 403 }),
        vi.fn(),
        write,
        signal(),
        vi.fn()
      )
    ).rejects.toThrow('HTTP 403');
    expect(write).not.toHaveBeenCalled();
  });
  it('requires a correct Content-Range and byte count for ranged segments', async () => {
    const ranged = plan('#EXTM3U\n#EXTINF:2,\n#EXT-X-BYTERANGE:188@0\na.ts\n#EXT-X-ENDLIST');
    await expect(
      writeHls(ranged, async () => new Response(ts()), vi.fn(), vi.fn(), signal(), vi.fn())
    ).rejects.toThrow('byte range');
    const write = vi.fn();
    await writeHls(
      ranged,
      async () =>
        new Response(ts(), { status: 206, headers: { 'Content-Range': 'bytes 0-187/188' } }),
      vi.fn(),
      write,
      signal(),
      vi.fn()
    );
    expect(write).toHaveBeenCalledOnce();
  });
  it('writes MP4 initialization before its fragments', async () => {
    const fragmented = plan(
      '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\na.m4s\n#EXT-X-ENDLIST'
    );
    const calls: string[] = [];
    await writeHls(
      fragmented,
      async part =>
        new Response(
          new Uint8Array([
            0,
            0,
            0,
            8,
            ...new TextEncoder().encode(part.url.endsWith('init.mp4') ? 'ftyp' : 'moof'),
          ])
        ),
      vi.fn(),
      async data => {
        calls.push(new TextDecoder().decode(data.slice(4)));
      },
      signal(),
      vi.fn()
    );
    expect(calls).toEqual(['ftyp', 'moof']);
  });
  it('stops fetching on cancellation', async () => {
    const abort = new AbortController();
    const fetchPart = vi.fn(async () => new Response(ts()));
    await expect(
      writeHls(
        plan(),
        fetchPart,
        vi.fn(),
        async () => {
          abort.abort();
        },
        abort.signal,
        vi.fn()
      )
    ).rejects.toThrow();
    expect(fetchPart).toHaveBeenCalledOnce();
  });
  it('bounds a chunked response without Content-Length', async () => {
    await expect(readHlsResponse(new Response(new Uint8Array(20)), 10, signal())).rejects.toThrow(
      'limit'
    );
  });
});
it('keeps saved filenames within the selected directory', () => {
  expect(safeVideoName('../A/B: lesson?')).toBe('_A_B_ lesson_');
  expect(safeVideoName('CON')).toBe('lecture_CON');
  expect(safeVideoName('Bản đồ tư duy')).toBe('Bản đồ tư duy');
  expect(() => hlsUrl('https://user:password@host.test/v.m3u8')).toThrow('credentials');
});
