export type PipelineState = 'IDLE' | 'ACTIVE' | 'FAILOVER' | 'RECOVERY' | 'ERROR';
export type StreamSource = 'primary' | 'backup' | 'none';
export type ScteState = 'normal' | 'cue-out' | 'cue-in';

export interface PipelineMetrics {
  type: 'metrics';
  timestamp: number;
  state: PipelineState;
  activeSource: StreamSource;
  scteState: ScteState;
  ingestBitrate: number;    // kbits/s
  encodingFps: number;
  encodingSpeed: number;    // 1.0 = realtime
  segmentCount: number;
  activeVariants: number;
}

export interface ScteEvent {
  type: 'scte35';
  timestamp: number;
  eventType: 'CUE-OUT' | 'CUE-IN';
  breakId: string;
  duration?: number;        // seconds, only on CUE-OUT
}

export interface FailoverEvent {
  type: 'failover';
  timestamp: number;
  from: string;
  to: string;
  reason: string;
}

export type OperationalEvent = ScteEvent | FailoverEvent;

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

/** One point in the rolling bitrate/fps history chart */
export interface MetricPoint {
  ts: number;
  bitrate: number;
  fps: number;
}
