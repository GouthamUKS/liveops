import { PipelineMetrics, PipelineState, StreamSource } from '../types';
import { OrchestratorEvent } from '../hooks/useOrchestrator';

const ORCH_STATE_COLOR: Record<string, string> = {
  CREATED:      '#555555',
  PROVISIONING: '#4488ff',
  READY:        '#4488ff',
  LIVE:         '#00ff88',
  FAILOVER:     '#ffcc00',
  STOPPING:     '#ffcc00',
  COMPLETED:    '#888888',
  ARCHIVED:     '#444444',
};

interface Props {
  metrics: PipelineMetrics | null;
  connected: boolean;
  uptime: number; // seconds
  onEmergencyStop: () => void;
  orchEvent: OrchestratorEvent | null;
}

function formatUptime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map(n => String(n).padStart(2, '0')).join(':');
}

const STATE_COLOR: Record<PipelineState, string> = {
  IDLE:     '#555555',
  ACTIVE:   '#00ff88',
  FAILOVER: '#ffcc00',
  RECOVERY: '#ffcc00',
  ERROR:    '#ff4444',
};

const SOURCE_COLOR: Record<StreamSource, string> = {
  primary: '#00ff88',
  backup:  '#ffcc00',
  none:    '#555555',
};

export function PipelineStatusBar({ metrics, connected, uptime, onEmergencyStop, orchEvent }: Props) {
  const state = metrics?.state ?? 'IDLE';
  const source = metrics?.activeSource ?? 'none';
  const scteState = metrics?.scteState ?? 'normal';
  const stateColor = STATE_COLOR[state];
  const pulseClass = state === 'ACTIVE' ? 'pulse-green' : state === 'FAILOVER' ? 'pulse-yellow' : '';

  return (
    <div
      className="flex items-center gap-6 px-5 text-xs border-b border-noc-border select-none shrink-0"
      style={{ background: '#0e0e0e', height: 56 }}
    >
      {/* Identity */}
      <span className="text-noc-green font-bold text-sm tracking-widest">LIVEOPS NOC</span>

      <div className="w-px h-6 bg-noc-border" />

      {/* Pipeline state */}
      <div className="flex items-center gap-2">
        <div
          className={`rounded-full ${pulseClass}`}
          style={{ width: 8, height: 8, background: stateColor, flexShrink: 0 }}
        />
        <span style={{ color: stateColor }} className="font-bold tracking-wider">{state}</span>
      </div>

      {/* Ingest source */}
      <div className="flex items-center gap-2">
        <span className="text-noc-muted">SOURCE</span>
        <span style={{ color: SOURCE_COLOR[source] }} className="font-bold">
          {source.toUpperCase()}
        </span>
      </div>

      {/* SCTE-35 state */}
      {scteState !== 'normal' && (
        <div className="flex items-center gap-2">
          <span className="text-noc-muted">SCTE-35</span>
          <span className="text-noc-yellow font-bold animate-pulse">{scteState.toUpperCase()}</span>
        </div>
      )}

      {/* Variants */}
      <div className="flex items-center gap-2">
        <span className="text-noc-muted">VARIANTS</span>
        <span className="text-noc-text">{metrics?.activeVariants ?? 0}/3</span>
      </div>

      {/* Uptime */}
      <div className="flex items-center gap-2">
        <span className="text-noc-muted">UPTIME</span>
        <span className="text-noc-text tabular-nums">{formatUptime(uptime)}</span>
      </div>

      {/* Orchestrator event indicator */}
      {orchEvent && (
        <>
          <div className="w-px h-6 bg-noc-border" />
          <div className="flex items-center gap-2">
            <span className="text-noc-muted">EVENT</span>
            <span
              className="font-bold tabular-nums px-1"
              style={{
                color: ORCH_STATE_COLOR[orchEvent.state] ?? '#888',
                border: `1px solid ${ORCH_STATE_COLOR[orchEvent.state] ?? '#888'}44`,
                background: `${ORCH_STATE_COLOR[orchEvent.state] ?? '#888'}11`,
                fontSize: 10,
                letterSpacing: '0.05em',
              }}
            >
              {orchEvent.id} · {orchEvent.state}
            </span>
          </div>
        </>
      )}

      {/* Right side */}
      <div className="ml-auto flex items-center gap-4">
        {/* WS connection indicator */}
        <div className="flex items-center gap-2">
          <div
            className={connected ? 'pulse-green' : 'pulse-red'}
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: connected ? '#00ff88' : '#ff4444',
              flexShrink: 0,
            }}
          />
          <span className="text-noc-muted" style={{ fontSize: 10 }}>
            {connected ? 'WS CONNECTED' : 'WS DISCONNECTED'}
          </span>
        </div>

        <div className="w-px h-6 bg-noc-border" />

        {/* Emergency stop */}
        <button
          onClick={onEmergencyStop}
          className="font-bold text-xs tracking-wider px-3 py-1 transition-opacity hover:opacity-80 active:opacity-60"
          style={{
            background: '#ff4444',
            color: '#000',
            border: 'none',
            cursor: 'pointer',
            letterSpacing: '0.05em',
          }}
        >
          ■ EMERGENCY STOP
        </button>
      </div>
    </div>
  );
}
