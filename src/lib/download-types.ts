export interface Preferences {
  video: boolean;
  transcript: boolean;
  automatic: boolean;
}

export interface DownloadItem {
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
