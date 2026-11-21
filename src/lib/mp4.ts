import {
  BlobSource,
  Conversion,
  Input,
  MP4,
  MPEG_TS,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
} from 'mediabunny';

/** Stage the stream on disk and copy its tracks into a regular, seekable MP4. */
export async function saveMp4(
  writeSource: (write: (bytes: Uint8Array) => Promise<void>) => Promise<void>,
  destination: FileSystemWritableFileStream,
  signal: AbortSignal,
  onConverting: () => void
): Promise<void> {
  const storage = await navigator.storage.getDirectory();
  const name = `media-${crypto.randomUUID()}`;
  const file = await storage.getFileHandle(name, { create: true });
  try {
    const writer = await file.createWritable();
    try {
      await writeSource(bytes => writer.write(bytes as BufferSource));
      signal.throwIfAborted();
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }

    onConverting();
    const input = new Input({
      source: new BlobSource(await file.getFile()),
      formats: [MP4, MPEG_TS],
    });
    try {
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: false }),
        target: new StreamTarget(
          new WritableStream<StreamTargetChunk>({
            write(chunk) {
              signal.throwIfAborted();
              return destination.write(chunk);
            },
          })
        ),
      });
      const conversion = await Conversion.init({
        input,
        output,
        copy: { mode: 'forced' },
        tracks: 'primary',
        showWarnings: false,
      });
      const video = await input.getPrimaryVideoTrack();
      const audio = await input.getPrimaryAudioTrack();
      if (
        !conversion.isValid ||
        !video ||
        !conversion.utilizedTracks.includes(video) ||
        (audio && !conversion.utilizedTracks.includes(audio))
      ) {
        throw new Error('The video or audio format cannot be saved as MP4 without re-encoding.');
      }
      signal.throwIfAborted();
      await conversion.execute();
    } finally {
      input.dispose();
    }
  } finally {
    await storage.removeEntry(name).catch(() => undefined);
  }
}
