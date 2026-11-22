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
  expect(contains).toHaveBeenCalledTimes(6);
  expect(
    contains.mock.calls.every(([query]) =>
      ['https://*/*', 'https://*.googlevideo.com/*'].includes(query.origins[0])
    )
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
it('reuses declared Udemy CDN access for different video hosts without a permission request', async () => {
  const contains = vi.fn(
    async ({ origins }: { origins: string[] }) => origins[0] === 'https://*.udemycdn.com/*'
  );
  vi.stubGlobal('chrome', { permissions: { contains } });
  await expect(
    checkHosts(['https://hls-c.udemycdn.com/video.m3u8', 'https://hls.udemycdn.com/part.ts'])
  ).resolves.toBeUndefined();
  expect(contains).toHaveBeenCalledTimes(2);
});
it('uses installation access for new HTTPS CDN hosts without per-host prompts', async () => {
  const contains = vi.fn(
    async ({ origins }: { origins: string[] }) => origins[0] === 'https://*/*'
  );
  vi.stubGlobal('chrome', { permissions: { contains } });
  await expect(
    checkHosts(['https://new-cdn.example/video.mp4', 'https://other-cdn.example/part.ts'])
  ).resolves.toBeUndefined();
  expect(contains).toHaveBeenCalledExactlyOnceWith({ origins: ['https://*/*'] });
});
it('continues to reject insecure or credential-bearing URLs even with installation access', async () => {
  vi.stubGlobal('chrome', { permissions: { contains: vi.fn(async () => true) } });
  await expect(checkHosts(['http://cdn.example/video.mp4'])).rejects.toThrow('HTTPS');
  await expect(checkHosts(['https://user:secret@cdn.example/video.mp4'])).rejects.toThrow(
    'credentials'
  );
});
