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
