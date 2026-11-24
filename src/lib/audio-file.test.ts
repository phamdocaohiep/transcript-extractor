import { readFileSync } from 'node:fs';
import { Input, BlobSource, MP4, WEBM, EncodedPacketSink } from 'mediabunny';
import { beforeEach, expect, it, vi } from 'vitest';
import { extractAudio, writeAudioSource } from './audio-file';

let bytes: Uint8Array;
let directory: FileSystemDirectoryHandle;
let close: ReturnType<typeof vi.fn>;
beforeEach(() => {
  bytes = new Uint8Array();
  close = vi.fn(async () => undefined);
  directory = {
    getFileHandle: vi.fn(async () => ({
      createWritable: async () => ({
        write: async (chunk: { position: number; data: Uint8Array }) => {
          const next = new Uint8Array(Math.max(bytes.length, chunk.position + chunk.data.length));
          next.set(bytes);
          next.set(chunk.data, chunk.position);
          bytes = next;
        },
        close,
        abort: vi.fn(async () => undefined),
      }),
    })),
  } as unknown as FileSystemDirectoryHandle;
});
it.each(['sound.m4a', 'sound.webm'])(
  'exports real compressed audio from %s without adding a video track',
  async filename => {
    const source = new File(
      [readFileSync(new URL(`./__fixtures__/media/${filename}`, import.meta.url))],
      filename
    );
    const name = await extractAudio(
      source,
      directory,
      'Example-audio',
      new AbortController().signal
    );
    expect(name).toBe(filename.endsWith('webm') ? 'Example-audio.webm' : 'Example-audio.m4a');
    const original = new Input({ source: new BlobSource(source), formats: [MP4, WEBM] });
    const result = new Input({
      source: new BlobSource(new File([bytes as BlobPart], name)),
      formats: [MP4, WEBM],
    });
    try {
      expect(await result.getPrimaryVideoTrack()).toBeNull();
      const audio = (await result.getPrimaryAudioTrack())!;
      const before = (await original.getPrimaryAudioTrack())!;
      expect(await audio.getCodec()).toBe(await before.getCodec());
      expect(await audio.computeDuration()).toBeCloseTo(await before.computeDuration(), 1);
      const packets = async (track: typeof audio) => {
        const data: number[][] = [];
        for await (const packet of new EncodedPacketSink(track).packets())
          data.push([...packet.data]);
        return data;
      };
      expect(await packets(audio)).toEqual(await packets(before));
      expect(close).toHaveBeenCalledOnce();
    } finally {
      original.dispose();
      result.dispose();
    }
  }
);
it('rejects a silent file and an aborted operation rather than publishing empty audio', async () => {
  const source = new File(
    [readFileSync(new URL('./__fixtures__/media/picture.mp4', import.meta.url))],
    'picture.mp4'
  );
  await expect(
    extractAudio(source, directory, 'audio', new AbortController().signal)
  ).rejects.toThrow('audio track');
  expect(close).not.toHaveBeenCalled();
  const controller = new AbortController();
  controller.abort();
  await expect(extractAudio(source, directory, 'audio', controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
});
it('rejects incomplete or failed explicit audio responses', async () => {
  await expect(
    writeAudioSource(
      new Response('Denied', { status: 403 }),
      vi.fn(),
      new AbortController().signal,
      vi.fn()
    )
  ).rejects.toThrow('403');
  await expect(
    writeAudioSource(
      new Response('small', { headers: { 'Content-Length': '1000' } }),
      vi.fn(),
      new AbortController().signal,
      vi.fn()
    )
  ).rejects.toThrow('incomplete');
});
