import type { ClientInfo } from 'googlevideo/protos';
import type { FormatStream } from 'googlevideo/shared-types';

/** Ephemeral page-owned playback data. Never persist or include it in logs. */
export interface SessionInfo {
  videoId: string;
  url: string;
  config: string;
  clientInfo: ClientInfo;
  token?: string;
}

export interface AdaptiveInfo extends SessionInfo {
  formats: FormatStream[];
  duration: number;
}

export interface RequestState {
  installed: true;
  session?: SessionInfo;
}
