import {
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MP4,
  WEBM,
  Mp4OutputFormat,
  WebMOutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
} from 'mediabunny';
import type { StreamInfo } from './stream-discovery';
import { writeStream } from './stream-file';

export interface TrackPlan {
  kind: 'tracks';
  video: StreamInfo;
  audio?: StreamInfo;
  extension: 'mp4' | 'webm';
}

/** Combine the original compressed tracks on disk; no local app or re-encoding. */
export async function saveTracks(
  plan: TrackPlan,
  fetchPart: (url: string, headers: HeadersInit) => Promise<Response>,
  destination: FileSystemWritableFileStream,
  signal: AbortSignal,
  progress: (completed: number, total: number, bytes: number) => void,
  notice: (value: string) => void
) {
  const storage = await navigator.storage.getDirectory();
  const names: string[] = [];
  const inputs: Input[] = [];
  let output: Output | undefined;
  let finalized = false;
  let bytes = 0;
  const total = plan.audio ? 2 : 1;
  const stage = async (stream: StreamInfo, index: number) => {
    const name = `media-${crypto.randomUUID()}`;
    names.push(name);
    const handle = await storage.getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    let received = 0;
    try {
      await writeStream(
        stream,
        fetchPart,
        chunk => writer.write(chunk as BufferSource),
        signal,
        count => {
          received = count;
          progress(index, total, bytes + count);
        }
      );
      signal.throwIfAborted();
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
    bytes += received;
    progress(index + 1, total, bytes);
    const input = new Input({
      source: new BlobSource(await handle.getFile()),
      formats: [MP4, WEBM],
    });
    inputs.push(input);
    return input;
  };
  try {
    notice('Downloading video…');
    const first = await stage(plan.video, 0);
    const second = plan.audio ? await stage(plan.audio, 1) : first;
    notice(`Combining video and audio into ${plan.extension.toUpperCase()}…`);
    const video = await first.getPrimaryVideoTrack();
    const audio = await second.getPrimaryAudioTrack();
    if (!video || !audio)
      throw new Error(
        'Both video and audio tracks are required. The server returned an incomplete media file.'
      );
    const videoCodec = await video.getCodec();
    const audioCodec = await audio.getCodec();
    const format =
      plan.extension === 'mp4' ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat();
    if (
      !videoCodec ||
      !audioCodec ||
      !format.getSupportedVideoCodecs().includes(videoCodec) ||
      !format.getSupportedAudioCodecs().includes(audioCodec)
    )
      throw new Error('These video and audio codecs cannot be combined without re-encoding.');
    const videoConfig = await video.getDecoderConfig();
    const audioConfig = await audio.getDecoderConfig();
    if (!videoConfig || !audioConfig)
      throw new Error('The downloaded tracks are missing decoder information.');
    const videoSource = new EncodedVideoPacketSource(videoCodec);
    const audioSource = new EncodedAudioPacketSource(audioCodec);
    output = new Output({
      format,
      target: new StreamTarget(
        new WritableStream<StreamTargetChunk>({
          write(chunk) {
            signal.throwIfAborted();
            return destination.write(chunk);
          },
        })
      ),
    });
    output.addVideoTrack(videoSource, { rotation: video.rotation });
    output.addAudioTrack(audioSource);
    await output.start();
    await Promise.all([
      (async () => {
        let count = 0;
        for await (const packet of new EncodedPacketSink(video).packets()) {
          signal.throwIfAborted();
          await videoSource.add(packet, count++ === 0 ? { decoderConfig: videoConfig } : undefined);
        }
        if (!count) throw new Error('The video track contains no frames.');
        videoSource.close();
      })(),
      (async () => {
        let count = 0;
        for await (const packet of new EncodedPacketSink(audio).packets()) {
          signal.throwIfAborted();
          await audioSource.add(packet, count++ === 0 ? { decoderConfig: audioConfig } : undefined);
        }
        if (!count) throw new Error('The audio track contains no samples.');
        audioSource.close();
      })(),
    ]);
    signal.throwIfAborted();
    await output.finalize();
    finalized = true;
  } finally {
    if (output && !finalized) await output.cancel().catch(() => undefined);
    inputs.forEach(input => input.dispose());
    await Promise.all(names.map(name => storage.removeEntry(name).catch(() => undefined)));
  }
}
