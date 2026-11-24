export interface Preferences {
  audio?: boolean;
  materials?: boolean;
  deleteFiles?: boolean;
  video: boolean;
  transcript: boolean;
  automatic: boolean;
  format?: 'mp4' | 'webm';
  maxHeight?: number;
  reload?: boolean;
}
export const selectionKey = (value: Pick<Preferences, 'format' | 'maxHeight'>) =>
  `${value.format || 'auto'}:${value.maxHeight || 0}`;

export interface DownloadItem {
  kind?: 'video' | 'article' | 'quiz';
  filename?: string;
  id: string;
  title: string;
  url?: string;
  section?: string;
  selected: boolean;
  status: 'pending' | 'downloading' | 'completed' | 'partial' | 'failed' | 'skipped';
  error?: string;
  saved?: SavedFiles;
  available?: boolean;
}
export interface SavedFiles {
  video: boolean;
  transcript: boolean;
  audio?: boolean;
}
export function requiredFiles(item: Pick<DownloadItem, 'kind'>, preferences: Preferences) {
  return item.kind === 'article' || item.kind === 'quiz'
    ? { video: false, audio: false, transcript: preferences.materials !== false }
    : {
        video: preferences.video,
        transcript: preferences.transcript,
        audio: preferences.audio === true,
      };
}
