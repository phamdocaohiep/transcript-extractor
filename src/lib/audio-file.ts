import {
  Input,
  BlobSource,
  MP4,
  MP3,
  WEBM,
  Output,
  Mp4OutputFormat,
  Mp3OutputFormat,
  WebMOutputFormat,
  StreamTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  type StreamTargetChunk,
} from 'mediabunny';

/** Copy the compressed audio track without re-encoding or loading the whole video into memory. */
export async function extractAudio(
  file: File,
  directory: FileSystemDirectoryHandle,
  base: string,
  signal: AbortSignal
): Promise<string> {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, WEBM, MP3] });
  let output: Output | undefined;
  let writer: FileSystemWritableFileStream | undefined;
  let finalized = false;
  try {
    signal.throwIfAborted();
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('This video does not contain an audio track.');
    const codec = await track.getCodec();
    const config = await track.getDecoderConfig();
    const format =
      codec === 'mp3'
        ? new Mp3OutputFormat()
        : codec === 'opus' || codec === 'vorbis'
          ? new WebMOutputFormat()
          : new Mp4OutputFormat({ fastStart: false });
    if (!codec || !config || !format.getSupportedAudioCodecs().includes(codec))
      throw new Error('This audio codec cannot be exported without re-encoding.');
    const name = `${base}.${codec === 'mp3' ? 'mp3' : codec === 'opus' || codec === 'vorbis' ? 'webm' : 'm4a'}`;
    writer = await (await directory.getFileHandle(name, { create: true })).createWritable();
    const source = new EncodedAudioPacketSource(codec);
    output = new Output({
      format,
      target: new StreamTarget(
        new WritableStream<StreamTargetChunk>({
          write(chunk) {
            signal.throwIfAborted();
            return writer!.write(chunk);
          },
        })
      ),
    });
    output.addAudioTrack(source);
    await output.start();
    let count = 0;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      signal.throwIfAborted();
      await source.add(packet, count++ === 0 ? { decoderConfig: config } : undefined);
    }
    if (!count) throw new Error('The audio track has no samples.');
    source.close();
    await output.finalize();
    signal.throwIfAborted();
    await writer.close();
    finalized = true;
    return name;
  } finally {
    if (output && !finalized) await output.cancel().catch(() => undefined);
    if (writer && !finalized) await writer.abort().catch(() => undefined);
    input.dispose();
  }
}

/** Stage an exposed audio source. The media parser validates it before any file is published. */
export async function writeAudioSource(
  response: Response,
  write: (bytes: Uint8Array) => Promise<void>,
  signal: AbortSignal,
  progress: (bytes: number) => void
): Promise<void> {
  if (!response.ok || !response.body)
    throw new Error(`Audio server returned HTTP ${response.status}.`);
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      if (next.value?.length) {
        await write(next.value);
        size += next.value.length;
        progress(size);
      }
    }
    const expected = Number(response.headers.get('content-length'));
    if (!size || (expected > 0 && expected !== size))
      throw new Error('The audio source was empty or incomplete.');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
