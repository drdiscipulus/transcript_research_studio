export type EditorPlayRequest = {
  id: number;
  action: "toggle" | "stop";
  segmentId: string;
  start: number;
  end: number;
};

export type EditorPlaybackStatus = "playing" | "paused" | "stopped";

export type EditorPlaybackState = {
  requestId: number;
  segmentId: string;
  status: EditorPlaybackStatus;
} | null;
