import { expect, it, vi } from 'vitest';
import { writeStream } from './stream-file';
import type { StreamInfo } from './stream-discovery';
const bytes = new Uint8Array(32);
bytes.set([0, 0, 0, 16, 102, 116, 121, 112]);
const stream: StreamInfo = {
  url: 'https://r1.googlevideo.com/videoplayback?id=test&sig=keep',
  size: bytes.length,
  mimeType: 'video/mp4',
  video: true,
  audio: false,
  height: 720,
  bitrate: 1000,
};
const signal = () => new AbortController().signal;
it('downloads every range in order and retains the signed query parameters', async () => {
  const written: number[] = [];
  const fetchPart = vi.fn(async (url: string, headers: HeadersInit) => {
    const range = new Headers(headers).get('Range')!.match(/bytes=(\d+)-(\d+)/)!;
    const start = Number(range[1]),
      end = Number(range[2]);
    expect(new URL(url).searchParams.get('range')).toBe(`${start}-${end}`);
    expect(new URL(url).searchParams.get('sig')).toBe('keep');
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` },
    });
  });
  await writeStream(
    stream,
    fetchPart,
    async value => {
      written.push(...value);
    },
    signal(),
    vi.fn(),
    8
  );
  expect(fetchPart).toHaveBeenCalledTimes(4);
  expect(written).toEqual([...bytes]);
});
it('rejects a short 200 response rather than saving the first seconds as a complete video', async () => {
  await expect(
    writeStream(stream, async () => new Response(bytes.slice(0, 16)), vi.fn(), signal(), vi.fn())
  ).rejects.toThrow('truncated');
});
it('rejects wrong offsets and changed file sizes', async () => {
  for (const range of ['bytes 1-8/32', 'bytes 0-7/40']) {
    await expect(
      writeStream(
        stream,
        async () =>
          new Response(bytes.slice(0, 8), { status: 206, headers: { 'Content-Range': range } }),
        vi.fn(),
        signal(),
        vi.fn(),
        8
      )
    ).rejects.toThrow('different byte range');
  }
});
it('rejects HTML login pages and expired links', async () => {
  await expect(
    writeStream(
      stream,
      async () => new Response('<html>Please sign in</html>'),
      vi.fn(),
      signal(),
      vi.fn()
    )
  ).rejects.toThrow('requested media file');
  await expect(
    writeStream(stream, async () => new Response(null, { status: 403 }), vi.fn(), signal(), vi.fn())
  ).rejects.toThrow('HTTP 403');
});
it('does not alter range parameters included in the signature', async () => {
  const fetchPart = vi.fn(async (url: string) => {
    expect(new URL(url).searchParams.get('range')).toBeNull();
    return new Response(bytes);
  });
  await writeStream(
    { ...stream, url: `${stream.url}&sparams=id,range` },
    fetchPart,
    vi.fn(),
    signal(),
    vi.fn()
  );
});
it('cancels before requesting another range', async () => {
  const abort = new AbortController();
  abort.abort();
  const fetchPart = vi.fn();
  await expect(writeStream(stream, fetchPart, vi.fn(), abort.signal, vi.fn())).rejects.toThrow();
  expect(fetchPart).not.toHaveBeenCalled();
});

it('does not accept an unbounded CDN fragment when the full file size is unknown', async () => {
  await expect(
    writeStream(
      { ...stream, size: undefined },
      async () => new Response(bytes),
      vi.fn(),
      signal(),
      vi.fn()
    )
  ).rejects.toThrow('complete file size');
});
