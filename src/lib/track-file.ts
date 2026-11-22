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
  notice: (value: string) => void,
  streaming?: {
    video: ReadableStream<ArrayBufferView>;
    audio: ReadableStream<ArrayBufferView>;
    duration: number;
  }
) {
  const storage = await navigator.storage.getDirectory();
  const names: string[] = [];
  const inputs: Input[] = [];
  let output: Output | undefined;
  let finalized = false;
  const counts = [0, 0];
  const completed = [false, false];
  const transferAbort = new AbortController();
  const token = AbortSignal.any([signal, transferAbort.signal]);
  const total = plan.audio ? 2 : 1;
  const stage = async (
    stream: StreamInfo,
    index: number,
    source?: ReadableStream<ArrayBufferView>
  ) => {
    const name = `media-${crypto.randomUUID()}`;
    names.push(name);
    const handle = await storage.getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    const update = (count: number) => {
      counts[index] = count;
      progress(completed.filter(Boolean).length, total, counts[0] + counts[1]);
    };
    try {
      if (source) {
        const reader = source.getReader();
        const cancel = () => {
          void reader.cancel(token.reason).catch(() => undefined);
        };
        token.addEventListener('abort', cancel, { once: true });
        try {
          while (true) {
            token.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) break;
            const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            await writer.write(bytes as BufferSource);
            update(counts[index] + bytes.length);
          }
        } finally {
          token.removeEventListener('abort', cancel);
          await reader.cancel().catch(() => undefined);
        }
      } else
        await writeStream(
          stream,
          fetchPart,
          chunk => writer.write(chunk as BufferSource),
          token,
          update
        );
      token.throwIfAborted();
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
    completed[index] = true;
    update(counts[index]);
    const input = new Input({
      source: new BlobSource(await handle.getFile()),
      formats: [MP4, WEBM],
    });
    inputs.push(input);
    return input;
  };
  try {
    notice('Downloading video…');
    let first: Input;
    let second: Input;
    if (streaming && plan.audio) {
      const transfers = [
        stage(plan.video, 0, streaming.video),
        stage(plan.audio, 1, streaming.audio),
      ];
      try {
        [first, second] = await Promise.all(transfers);
      } catch (error) {
        transferAbort.abort(error);
        await Promise.allSettled(transfers);
        throw error;
      }
    } else {
      first = await stage(plan.video, 0);
      second = plan.audio ? await stage(plan.audio, 1) : first;
    }
    notice(`Combining video and audio into ${plan.extension.toUpperCase()}…`);
    const video = await first.getPrimaryVideoTrack();
    const audio = await second.getPrimaryAudioTrack();
    if (!video || !audio)
      throw new Error(
        'Both video and audio tracks are required. The server returned an incomplete media file.'
      );
    if (streaming) {
      const minimum = streaming.duration - Math.max(1, streaming.duration * 0.005);
      if ((await video.computeDuration()) < minimum || (await audio.computeDuration()) < minimum)
        throw new Error('The playback stream ended before the full video was downloaded.');
    }
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
