import { useState } from 'react';
import { clearDiagnostics, exportDiagnostics } from '../lib/diagnostics';
import { ExtensionService } from '../lib/extension-service';

export function Diagnostics({ busy = false }: { busy?: boolean }) {
  const [message, setMessage] = useState('');
  async function download() {
    try {
      const content = await exportDiagnostics();
      const name = `download-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      ExtensionService.downloadFile(content, name, 'application/json');
      setMessage('Diagnostic log prepared. You can attach the JSON file when reporting an issue.');
    } catch {
      setMessage('Could not read the diagnostic log.');
    }
  }
  return (
    <details className="te-glass p-4">
      <summary className="font-semibold cursor-pointer">Diagnostics</summary>
      <div className="flex flex-col gap-3 mt-3">
        <p className="te-muted text-sm">
          Download activity is recorded in this Chrome profile. The log includes permission results,
          server hosts, response codes and saved-file status. It excludes cookies, tokens, signed
          URLs, video titles, transcripts and folder paths.
        </p>
        <button className="te-btn" onClick={() => void download()}>
          Download diagnostic log
        </button>
        <button
          className="te-btn"
          disabled={busy}
          onClick={() => {
            void clearDiagnostics()
              .then(() => setMessage('Diagnostic log cleared.'))
              .catch(() => setMessage('Could not clear the diagnostic log.'));
          }}
        >
          Clear log
        </button>
        {message && (
          <p role="status" className="te-muted text-sm">
            {message}
          </p>
        )}
      </div>
    </details>
  );
}
