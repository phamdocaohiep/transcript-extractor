import { useRef, useState } from 'react';
import {
  backupCounts,
  createBackup,
  MAX_BACKUP_BYTES,
  parseBackup,
  restoreBackup,
  type Backup,
} from '../lib/backup';

export function BackupControls({ onChanged }: { onChanged: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Backup | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  async function download() {
    setBusy(true);
    setNotice('');
    try {
      const backup = await createBackup();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(backup)], { type: 'application/json' })
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `transcript-backup-${backup.createdAt.slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('Backup downloaded. Keep a copy outside this browser profile.');
      await onChanged();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Backup failed.');
    } finally {
      setBusy(false);
    }
  }

  async function inspect(file: File | undefined) {
    setPending(null);
    setNotice('');
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error('Backup exceeds the 250 MB limit.');
      setPending(parseBackup(await file.text()));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not read this backup.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function restore() {
    if (!pending) return;
    setBusy(true);
    try {
      await restoreBackup(pending);
      setPending(null);
      await onChanged();
      setNotice('Restore complete. Existing items were kept.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Restore failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Backup and restore" className="flex flex-col gap-2 text-xs">
      <strong>Backup and restore</strong>
      <span>
        Your library stays in this browser. Back up before clearing browser data or removing the
        extension.
      </span>
      <div className="flex flex-wrap gap-2">
        <button className="te-btn" disabled={busy} onClick={() => void download()}>
          Download backup
        </button>
        <button className="te-btn" disabled={busy} onClick={() => input.current?.click()}>
          Restore backup…
        </button>
      </div>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={event => void inspect(event.target.files?.[0])}
      />
      {pending && (
        <div role="region" aria-label="Restore preview" className="flex flex-col gap-2">
          <p>
            Backup from {new Date(pending.createdAt).toLocaleString()}: {backupCounts(pending)}.
          </p>
          <p>Merge into this library. Existing items with matching IDs will be kept.</p>
          <div className="flex gap-2">
            <button className="te-btn" disabled={busy} onClick={() => void restore()}>
              Merge backup
            </button>
            <button className="te-btn" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">Working…</p>}
    </section>
  );
}
