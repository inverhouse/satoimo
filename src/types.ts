export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

export type Screen = "home" | "proxy" | "record" | "review" | "export" | "complete" | "recovery";
export type RecordingState =
  | "PREPARING"
  | "STARTING"
  | "RECORDING_PAUSED"
  | "RECORDING_PLAYING"
  | "RECORDING_SCRUB"
  | "STOP_HOLDING"
  | "FINALIZING"
  | "REVIEW_PREPARING";

export interface Fingerprint {
  sizeBytes: number;
  modifiedAtMs: number;
  headTailSha256: string;
}

export interface SourceInfo {
  absolutePath: string;
  relativePath: string | null;
  fingerprint: Fingerprint;
  durationUs: number;
  width: number;
  height: number;
  fpsNumerator: number;
  fpsDenominator: number;
  videoCodec: string;
  audioCodec: string | null;
  hasAudio: boolean;
  rotationDegrees: number;
}

export interface TakeInfo {
  id: string;
  durationUs: number;
  eventsPath: string;
  audioPath: string;
  recovered: boolean;
}

export interface Project {
  schemaVersion: 1;
  appVersion: string;
  projectId: string;
  name: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  source: SourceInfo;
  mediaUrl: string;
  audioUrl: string;
  proxy: { status: "none" | "needed" | "creating" | "ready"; relativePath: string | null };
  mix: { microphoneGain: number; sourceGain: number };
  pen: { color: string; widthNormalized: number };
  take: TakeInfo | null;
  lastSourcePositionUs: number;
  ui: { rightPanelCollapsed: boolean };
}

export type EventType =
  | "session_start" | "play" | "pause" | "seek" | "rate_change"
  | "stroke_begin" | "stroke_point" | "stroke_end" | "stroke_hide"
  | "session_stop" | "interruption";

export interface SessionEvent {
  schemaVersion: 1;
  seq: number;
  sessionUs: number;
  type: EventType;
  payload: Record<string, unknown>;
}

export type OutputSegment =
  | { kind: "play"; outputStartUs: number; outputDurationUs: number; sourceStartUs: number; sourceEndUs: number; rate: number }
  | { kind: "freeze"; outputStartUs: number; outputDurationUs: number; sourceFrameUs: number };

export interface StrokePoint { x: number; y: number; sessionUs: number; pressure: number }
export interface Stroke {
  id: string;
  color: string;
  widthNormalized: number;
  startUs: number;
  hiddenAtUs?: number;
  points: StrokePoint[];
}

export interface InputDevice { id: string; name: string; isDefault: boolean; sampleRate: number; channels: number; sampleFormat: string }
export interface RecoveryCandidate { projectPath: string; projectName: string; audioBytes: number; validEventCount: number }
export interface ExportProgress { percent: number; elapsedUs: number; remainingUs: number | null; outputPath: string }
