// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Diagnostics } from './Diagnostics';
import { ExtensionService } from '../lib/extension-service';
vi.mock('../lib/diagnostics', () => ({
  exportDiagnostics: vi.fn(async () => '{"schema":1,"events":[]}'),
  clearDiagnostics: vi.fn(async () => undefined),
}));
vi.mock('../lib/extension-service', () => ({ ExtensionService: { downloadFile: vi.fn() } }));
it('provides a JSON log download without requiring a connected source tab', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Diagnostics />));
    await act(async () => {
      container.querySelector('button')!.click();
    });
    expect(ExtensionService.downloadFile).toHaveBeenCalledWith(
      '{"schema":1,"events":[]}',
      expect.stringMatching(/^download-diagnostics-.*\.json$/),
      'application/json'
    );
    expect(container.textContent).toContain('attach the JSON file');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
