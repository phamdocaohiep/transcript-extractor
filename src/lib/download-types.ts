export interface Preferences {
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
  filename?: string;
  id: string;
  title: string;
  url?: string;
  section?: string;
  selected: boolean;
  status: 'pending' | 'downloading' | 'completed' | 'partial' | 'failed' | 'skipped';
  error?: string;
  saved?: { video: boolean; transcript: boolean };
  available?: boolean;
}
