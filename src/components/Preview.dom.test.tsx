// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Preview } from './Preview';
it('shows a video thumbnail, hides failed previews and rejects unsafe poster URLs', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<Preview url="https://www.youtube.com/watch?v=example" title="Example" />)
    );
    const image = container.querySelector('img')!;
    expect(image.src).toBe('https://i.ytimg.com/vi/example/mqdefault.jpg');
    expect(image.alt).toBe('Preview: Example');
    await act(async () => image.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')).toBeNull();
    await act(async () =>
      root.render(<Preview thumbnail="https://cdn.test/poster.jpg" title="Poster" />)
    );
    expect(container.querySelector('img')?.src).toBe('https://cdn.test/poster.jpg');
    await act(async () => root.render(<Preview thumbnail="javascript:alert(1)" title="Invalid" />));
    expect(container.querySelector('img')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
