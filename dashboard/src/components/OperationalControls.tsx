import { useState } from 'react';

interface Props {
  orchestratorUrl: string;
  transcoderUrl: string;
  eventId: string | null;
  isLive: boolean;
  onFeedKill: () => void;
  onFeedRestore: () => void;
  onLifecycleAction?: () => void;  // refresh orchestrator state after lifecycle transitions
}

type ButtonState = 'idle' | 'loading' | 'ok' | 'err';

function ControlButton({
  label,
  onClick,
  variant = 'default',
  disabled,
}: {
  label: string;
  onClick: () => void | Promise<void>;
  variant?: 'default' | 'danger' | 'warn' | 'success';
  disabled?: boolean;
}) {
  const [state, setState] = useState<ButtonState>('idle');

  const colors: Record<string, { bg: string; text: string; border: string }> = {
    default:  { bg: '#161616', text: '#e0e0e0', border: '#333' },
    danger:   { bg: '#2a0a0a', text: '#ff4444', border: '#ff444466' },
    warn:     { bg: '#1a1600', text: '#ffcc00', border: '#ffcc0066' },
    success:  { bg: '#0a1a0e', text: '#00ff88', border: '#00ff8866' },
  };

  const c = colors[variant];

  const handleClick = async () => {
    if (state === 'loading' || disabled) return;
    setState('loading');
    try {
      await onClick();
      setState('ok');
      setTimeout(() => setState('idle'), 1500);
    } catch {
      setState('err');
      setTimeout(() => setState('idle'), 2000);
    }
  };

  const displayLabel =
    state === 'loading' ? '...' :
    state === 'ok'      ? '✓ OK' :
    state === 'err'     ? '✗ ERR' :
    label;

  const textColor =
    state === 'ok'  ? '#00ff88' :
    state === 'err' ? '#ff4444' :
    c.text;

  return (
    <button
      onClick={handleClick}
      disabled={disabled || state === 'loading'}
      className="font-mono font-bold transition-opacity hover:opacity-80 active:opacity-50 disabled:opacity-30"
      style={{
        background: c.bg,
        color: textColor,
        border: `1px solid ${c.border}`,
        padding: '8px 16px',
        fontSize: 11,
        letterSpacing: '0.05em',
        cursor: disabled || state === 'loading' ? 'not-allowed' : 'pointer',
        minWidth: 110,
        whiteSpace: 'nowrap',
      }}
    >
      {displayLabel}
    </button>
  );
}

export function OperationalControls({ orchestratorUrl, transcoderUrl, eventId, isLive, onFeedKill, onFeedRestore, onLifecycleAction }: Props) {
  const [feedKilled, setFeedKilled] = useState(false);

  const apiCall = async (baseUrl: string, path: string, method = 'POST', body?: object) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  // Ad break: call transcoder directly (Phase 3); orchestrator in Phase 5 when eventId exists
  const triggerAdBreak = (duration: number) => async () => {
    if (eventId) {
      await apiCall(orchestratorUrl, `/events/${eventId}/ad-break`, 'POST', { duration });
    } else {
      await apiCall(transcoderUrl, '/scte35/cue-out', 'POST', { duration });
    }
  };

  const killPrimary = async () => {
    await apiCall(orchestratorUrl, '/ingest/primary/stop', 'PUT');
    setFeedKilled(true);
    onFeedKill();
  };

  const restorePrimary = async () => {
    await apiCall(orchestratorUrl, '/ingest/primary/start', 'PUT');
    setFeedKilled(false);
    onFeedRestore();
  };

  const lifecycleAction = (action: string, method = 'PUT') => async () => {
    if (!eventId) throw new Error('No active event — provision one first');
    await apiCall(orchestratorUrl, `/events/${eventId}/${action}`, method);
    onLifecycleAction?.();
  };

  return (
    <div
      className="flex items-center gap-8 px-5 border-t border-noc-border shrink-0 overflow-x-auto"
      style={{ background: '#0e0e0e', height: 84 }}
    >
      {/* Ad break */}
      <div className="flex flex-col gap-1 shrink-0">
        <span className="text-noc-muted" style={{ fontSize: 9, letterSpacing: '0.1em' }}>
          TRIGGER AD BREAK
        </span>
        <div className="flex gap-2">
          <ControlButton label="15s" onClick={triggerAdBreak(15)} variant="warn" disabled={!isLive} />
          <ControlButton label="30s" onClick={triggerAdBreak(30)} variant="warn" disabled={!isLive} />
          <ControlButton label="60s" onClick={triggerAdBreak(60)} variant="warn" disabled={!isLive} />
        </div>
      </div>

      <div className="w-px h-12 bg-noc-border shrink-0" />

      {/* Feed management */}
      <div className="flex flex-col gap-1 shrink-0">
        <span className="text-noc-muted" style={{ fontSize: 9, letterSpacing: '0.1em' }}>
          FEED MANAGEMENT
        </span>
        <div className="flex gap-2">
          <ControlButton
            label="KILL PRIMARY"
            onClick={killPrimary}
            variant="danger"
            disabled={feedKilled}
          />
          <ControlButton
            label="RESTORE PRIMARY"
            onClick={restorePrimary}
            variant="success"
            disabled={!feedKilled}
          />
        </div>
      </div>

      <div className="w-px h-12 bg-noc-border shrink-0" />

      {/* Event lifecycle */}
      <div className="flex flex-col gap-1 shrink-0">
        <span className="text-noc-muted" style={{ fontSize: 9, letterSpacing: '0.1em' }}>
          EVENT LIFECYCLE
        </span>
        <div className="flex gap-2">
          <ControlButton label="PROVISION" onClick={lifecycleAction('provision')} />
          <ControlButton label="GO LIVE"   onClick={lifecycleAction('start')} variant="success" />
          <ControlButton label="STOP"      onClick={lifecycleAction('stop')} variant="warn" />
          <ControlButton label="TEARDOWN"  onClick={lifecycleAction('teardown', 'DELETE')} variant="danger" />
        </div>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* HLS stream link */}
      <a
        href="http://localhost:8090/live/master.m3u8"
        target="_blank"
        rel="noreferrer"
        className="text-noc-blue hover:text-noc-green transition-colors shrink-0"
        style={{ fontSize: 10, textDecoration: 'none', letterSpacing: '0.05em' }}
      >
        ▶ OPEN HLS STREAM ↗
      </a>
    </div>
  );
}
