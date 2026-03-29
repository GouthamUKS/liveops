import { useState, useEffect, useRef } from 'react';
import { useMetricsSocket } from './hooks/useMetricsSocket';
import { useOrchestrator } from './hooks/useOrchestrator';
import { PipelineStatusBar } from './components/PipelineStatusBar';
import { LiveMetricsPanel } from './components/LiveMetricsPanel';
import { Scte35EventLog } from './components/Scte35EventLog';
import { OperationalControls } from './components/OperationalControls';

const WS_URL           = import.meta.env.VITE_WS_URL           || 'ws://localhost:3001';
const ORCHESTRATOR_URL = import.meta.env.VITE_ORCHESTRATOR_URL || 'http://localhost:5000';
const TRANSCODER_URL   = import.meta.env.VITE_TRANSCODER_URL   || 'http://localhost:3002';

export function App() {
  const { connected, latest, history, events, latestQc } = useMetricsSocket(WS_URL);
  const { event: orchEvent, available: orchAvailable, refresh: orchRefresh } = useOrchestrator(ORCHESTRATOR_URL);

  // Uptime — starts counting when pipeline first goes ACTIVE
  const [uptime, setUptime] = useState(0);
  const uptimeStartRef = useRef<number | null>(null);
  const lastStateRef = useRef<string>('IDLE');

  useEffect(() => {
    if (latest?.state === 'ACTIVE' && lastStateRef.current !== 'ACTIVE') {
      if (uptimeStartRef.current === null) {
        uptimeStartRef.current = Date.now();
      }
    }
    if (latest?.state === 'IDLE' && lastStateRef.current !== 'IDLE') {
      uptimeStartRef.current = null;
      setUptime(0);
    }
    lastStateRef.current = latest?.state ?? 'IDLE';
  }, [latest?.state]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (uptimeStartRef.current !== null) {
        setUptime(Math.floor((Date.now() - uptimeStartRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Event duration: time span of the rolling history window (for SCTE timeline)
  const firstMetricTs  = history.length > 0 ? history[0].ts : null;
  const latestMetricTs = history.length > 0 ? history[history.length - 1].ts : null;
  const eventDurationSec =
    firstMetricTs && latestMetricTs
      ? Math.ceil((latestMetricTs - firstMetricTs) / 1000)
      : 0;

  const handleEmergencyStop = async () => {
    try {
      await fetch(`${ORCHESTRATOR_URL}/events/current/stop`, { method: 'PUT' });
      orchRefresh();
    } catch {
      console.warn('[dashboard] Emergency stop: orchestrator not reachable');
    }
  };

  return (
    <div
      className="flex flex-col font-mono"
      style={{ height: '100vh', background: '#0a0a0a', overflow: 'hidden' }}
    >
      {/* Row 1 — Status bar */}
      <PipelineStatusBar
        metrics={latest}
        connected={connected}
        uptime={uptime}
        onEmergencyStop={handleEmergencyStop}
        orchEvent={orchAvailable ? orchEvent : null}
      />

      {/* Row 2 — Main panels */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Live metrics (60%) */}
        <div className="flex-[3] overflow-hidden">
          <LiveMetricsPanel metrics={latest} history={history} latestQc={latestQc} />
        </div>

        {/* Right: Operational event log (40%) */}
        <div className="flex-[2] overflow-hidden">
          <Scte35EventLog events={events} eventDurationSec={eventDurationSec} />
        </div>
      </div>

      {/* Row 3 — Operational controls */}
      <OperationalControls
        orchestratorUrl={ORCHESTRATOR_URL}
        transcoderUrl={TRANSCODER_URL}
        eventId={orchEvent?.id ?? null}
        isLive={latest?.state === 'ACTIVE'}
        onFeedKill={() => console.log('[dashboard] Primary feed killed')}
        onFeedRestore={() => { console.log('[dashboard] Primary feed restored'); }}
        onLifecycleAction={orchRefresh}
      />
    </div>
  );
}
