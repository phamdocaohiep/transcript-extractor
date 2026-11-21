import { afterEach, expect, it, vi } from 'vitest';
import { checkHosts, HostAccessNeeded } from './download';
afterEach(() => vi.unstubAllGlobals());
it('requests one YouTube CDN grant for both tracks and reuses it after server changes', async () => {
  let granted = false;
  vi.stubGlobal('chrome', { permissions: { contains: vi.fn(async () => granted) } });
  try {
    await checkHosts([
      'https://r1.googlevideo.com/videoplayback?sig=one',
      'https://r2.googlevideo.com/videoplayback?sig=two',
    ]);
    throw new Error('Expected permission request');
  } catch (error) {
    expect(error).toBeInstanceOf(HostAccessNeeded);
    expect((error as HostAccessNeeded).origins).toEqual(['https://*.googlevideo.com/*']);
  }
  granted = true;
  await expect(
    checkHosts(['https://r3.googlevideo.com/videoplayback?sig=three'])
  ).resolves.toBeUndefined();
});
it('keeps requests to unrelated hosts limited to their own origin', async () => {
  vi.stubGlobal('chrome', { permissions: { contains: vi.fn(async () => false) } });
  await expect(checkHosts(['https://cdn.example.com/video.mp4'])).rejects.toMatchObject({
    origins: ['https://cdn.example.com/*'],
  });
});
it('uses the granted CDN family without asking again for each new video server', async () => {
  const contains = vi.fn(
    async ({ origins }: { origins: string[] }) => origins[0] === 'https://*.googlevideo.com/*'
  );
  vi.stubGlobal('chrome', { permissions: { contains } });
  for (const server of ['r1', 'r2', 'r3']) {
    await expect(
      checkHosts([`https://${server}.googlevideo.com/videoplayback`])
    ).resolves.toBeUndefined();
  }
  expect(contains).toHaveBeenCalledTimes(3);
  expect(
    contains.mock.calls.every(([query]) => query.origins[0] === 'https://*.googlevideo.com/*')
  ).toBe(true);
});
it('retains a previously granted individual server without requesting broader access', async () => {
  vi.stubGlobal('chrome', {
    permissions: {
      contains: vi.fn(
        async ({ origins }: { origins: string[] }) => origins[0] === 'https://r1.googlevideo.com/*'
      ),
    },
  });
  await expect(checkHosts(['https://r1.googlevideo.com/videoplayback'])).resolves.toBeUndefined();
});
it('does not treat a similarly named unrelated host as part of the CDN family', async () => {
  vi.stubGlobal('chrome', { permissions: { contains: vi.fn(async () => false) } });
  await expect(checkHosts(['https://notgooglevideo.com/video.mp4'])).rejects.toMatchObject({
    origins: ['https://notgooglevideo.com/*'],
  });
});
