export type PipelineState = 'IDLE' | 'ACTIVE' | 'FAILOVER' | 'RECOVERY' | 'ERROR';
export type StreamSource = 'primary' | 'backup' | 'none';
export type ScteState = 'normal' | 'cue-out' | 'cue-in';

export interface FFmpegMetrics {
  bitrate: number;   // kbits/s parsed from stderr
  fps: number;       // encoding fps
  speed: number;     // speed multiplier (1.0 = realtime)
  elapsed: string;   // hh:mm:ss.ms
}

export interface PipelineMetrics {
  type: 'metrics';
  timestamp: number;
  state: PipelineState;
  activeSource: StreamSource;
  scteState: ScteState;
  ingestBitrate: number;
  encodingFps: number;
  encodingSpeed: number;
  segmentCount: number;
  activeVariants: number;
}

export interface ScteEvent {
  type: 'scte35';
  timestamp: number;
  eventType: 'CUE-OUT' | 'CUE-IN';
  breakId: string;
  duration?: number;
}

export interface FailoverEvent {
  type: 'failover';
  timestamp: number;
  from: string;
  to: string;
  reason: string;
}

export interface QcCheckResult {
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  value: number;
  unit: string;
  detail: string;
}

export interface QcResult {
  type: 'qc';
  timestamp: number;
  variant: string;
  segment: string;
  overall: 'PASS' | 'WARN' | 'FAIL';
  checks: QcCheckResult[];
}

export type WsMessage = PipelineMetrics | ScteEvent | FailoverEvent | QcResult;
