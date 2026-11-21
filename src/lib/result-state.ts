import type { DownloadItem, Preferences } from './download-types';

export function getSaved(item: DownloadItem, preferences: Preferences) {
  return (
    item.saved || {
      video: preferences.video && (item.status === 'completed' || item.status === 'partial'),
      transcript: preferences.transcript && item.status === 'completed',
    }
  );
}

export function getCounts(items: DownloadItem[], preferences: Preferences) {
  const files = items.map(item => getSaved(item, preferences));
  return {
    total: items.length,
    saved: files.filter(
      file => (preferences.video && file.video) || (preferences.transcript && file.transcript)
    ).length,
    video: files.filter(file => file.video).length,
    transcript: files.filter(file => file.transcript).length,
    partial: items.filter(item => item.status === 'partial').length,
    skipped: items.filter(item => item.status === 'skipped').length,
    failed: items.filter(item => item.status === 'failed').length,
  };
}
