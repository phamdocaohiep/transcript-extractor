import { describe, expect, it, vi } from 'vitest';
import { probeMediaFile, writeMediaFile } from './media-file';

const header = new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]);
const signal = () => new AbortController().signal;

describe('direct MP4 streaming', () => {
  it('checks the MP4 header across chunks and streams the complete file', async () => {
    const chunks = [header.slice(0, 6), header.slice(6), new Uint8Array([1, 2, 3])];
    const response = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        })
      );
    await probeMediaFile(response(), signal());
    const writes: Uint8Array[] = [];
    const progress = vi.fn();
    await writeMediaFile(
      response(),
      async bytes => {
        writes.push(bytes);
      },
      signal(),
      progress
    );
    expect(writes.map(bytes => [...bytes])).toEqual([[...header], [1, 2, 3]]);
    expect(progress).toHaveBeenLastCalledWith(15);
  });
  it('rejects a login page before writing a file', async () => {
    const write = vi.fn();
    await expect(
      writeMediaFile(new Response('<html>sign in</html>'), write, signal(), vi.fn())
    ).rejects.toThrow('MP4');
    expect(write).not.toHaveBeenCalled();
  });
});
