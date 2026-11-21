/** Stream a direct MP4 to disk without buffering the entire file in memory. */
export async function writeMediaFile(
  response: Response,
  write: (bytes: Uint8Array) => Promise<void>,
  signal: AbortSignal,
  progress: (bytes: number) => void
): Promise<void> {
  if (!response.ok)
    throw new Error(
      `Video server returned HTTP ${response.status}. Check your Chrome sign-in or refresh the video link.`
    );
  if (!response.body) throw new Error('The video server returned an empty response.');
  const reader = response.body.getReader();
  let header = new Uint8Array(0);
  let total = 0;
  let validated = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      if (!validated) {
        const combined = new Uint8Array(header.length + value.length);
        combined.set(header);
        combined.set(value, header.length);
        header = combined;
        if (header.length < 12) continue;
        if (new TextDecoder().decode(header.slice(4, 8)) !== 'ftyp')
          throw new Error(
            'The server did not return an MP4 video. Check your Chrome sign-in or refresh the video link.'
          );
        await write(header);
        total += header.length;
        progress(total);
        validated = true;
        continue;
      }
      await write(value);
      total += value.length;
      progress(total);
    }
    if (!total) throw new Error('The MP4 video was empty or incomplete.');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function probeMediaFile(response: Response, signal: AbortSignal): Promise<void> {
  if (!response.ok)
    throw new Error(
      `Video server returned HTTP ${response.status}. Check your Chrome sign-in or refresh the video link.`
    );
  if (!response.body) throw new Error('The video server returned an empty response.');
  const reader = response.body.getReader();
  const header: number[] = [];
  try {
    while (header.length < 12) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      header.push(...value.slice(0, 12 - header.length));
    }
    if (new TextDecoder().decode(Uint8Array.from(header.slice(4, 8))) !== 'ftyp')
      throw new Error(
        'The server did not return an MP4 video. Check your Chrome sign-in or refresh the video link.'
      );
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
