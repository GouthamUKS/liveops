import { OperationalEvent, ScteEvent, FailoverEvent } from '../types';

interface Props {
  events: OperationalEvent[];
  eventDurationSec: number;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// ── SCTE-35 row ───────────────────────────────────────────────────────────────
function ScteRow({ event, index }: { event: ScteEvent; index: number }) {
  const isCueOut = event.eventType === 'CUE-OUT';
  const color = isCueOut ? '#ffcc00' : '#00ff88';

  return (
    <div
      className="flex items-start gap-4 px-4 py-3 border-b border-noc-border font-mono"
      style={{ background: index % 2 === 0 ? '#0e0e0e' : '#111111' }}
    >
      <span
        className="font-bold shrink-0 px-2 py-0.5 text-center"
        style={{
          color,
          border: `1px solid ${color}44`,
          background: `${color}11`,
          fontSize: 10,
          letterSpacing: '0.04em',
          minWidth: 72,
        }}
      >
        {event.eventType}
      </span>

      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <span className="text-noc-text truncate" style={{ fontSize: 12 }}>{event.breakId}</span>
        {isCueOut && event.duration && (
          <span className="text-noc-muted" style={{ fontSize: 11 }}>{event.duration}s planned</span>
        )}
      </div>

      <span className="text-noc-muted tabular-nums ml-auto shrink-0" style={{ fontSize: 11 }}>
        {formatTime(event.timestamp)}
      </span>
    </div>
  );
}

// ── Failover row ──────────────────────────────────────────────────────────────
function FailoverRow({ event, index }: { event: FailoverEvent; index: number }) {
  const isFailover = event.to === 'FAILOVER';
  const isRecovery = event.to === 'RECOVERY';
  const isHealthy  = event.to === 'HEALTHY';

  const color =
    isFailover ? '#ff4444' :
    isRecovery ? '#ffcc00' :
    isHealthy  ? '#00ff88' :
    '#888888';

  const label =
    isFailover ? 'FAILOVER' :
    isRecovery ? 'RECOVERY' :
    isHealthy  ? 'HEALTHY'  :
    event.to;

  return (
    <div
      className="flex items-start gap-4 px-4 py-3 border-b border-noc-border font-mono"
      style={{ background: index % 2 === 0 ? '#0e0e0e' : '#111111' }}
    >
      <span
        className="font-bold shrink-0 px-2 py-0.5 text-center"
        style={{
          color,
          border: `1px solid ${color}44`,
          background: `${color}11`,
          fontSize: 10,
          letterSpacing: '0.04em',
          minWidth: 72,
        }}
      >
        ⚡ {label}
      </span>

      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <span style={{ fontSize: 12, color: '#aaa' }}>
          {event.from} → {event.to}
        </span>
        <span className="text-noc-muted truncate" style={{ fontSize: 11 }}>
          {event.reason}
        </span>
      </div>

      <span className="text-noc-muted tabular-nums ml-auto shrink-0" style={{ fontSize: 11 }}>
        {formatTime(event.timestamp)}
      </span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function Scte35EventLog({ events, eventDurationSec }: Props) {
  const scteEvents = events.filter((e): e is ScteEvent => e.type === 'scte35');
  const cueOutEvents = scteEvents.filter(e => e.eventType === 'CUE-OUT');
  const failoverEvents = events.filter((e): e is FailoverEvent => e.type === 'failover');

  return (
    <div className="flex flex-col h-full" style={{ background: '#0a0a0a' }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-noc-border shrink-0"
        style={{ background: '#0e0e0e' }}
      >
        <span className="text-noc-muted font-bold" style={{ fontSize: 10, letterSpacing: '0.12em' }}>
          OPS EVENT LOG
        </span>
        <div className="flex items-center gap-3">
          {failoverEvents.length > 0 && (
            <span
              className="tabular-nums px-2 py-0.5"
              style={{ fontSize: 10, color: '#ff4444', border: '1px solid #ff444444', background: '#ff444411' }}
            >
              {failoverEvents.length} FAILOVER
            </span>
          )}
          <span
            className="tabular-nums px-2 py-0.5"
            style={{
              fontSize: 10,
              color: scteEvents.length > 0 ? '#ffcc00' : '#555',
              border: '1px solid',
              borderColor: scteEvents.length > 0 ? '#ffcc0044' : '#333',
              background: scteEvents.length > 0 ? '#ffcc0011' : 'transparent',
            }}
          >
            {scteEvents.length} SCTE-35
          </span>
        </div>
      </div>

      {/* SCTE-35 ad break timeline */}
      {eventDurationSec > 0 && cueOutEvents.length > 0 && (
        <div className="px-4 py-3 border-b border-noc-border shrink-0">
          <div className="text-noc-muted mb-2" style={{ fontSize: 9, letterSpacing: '0.08em' }}>
            AD BREAK TIMELINE
          </div>
          <div
            className="relative w-full overflow-hidden"
            style={{ height: 10, background: '#1a1a1a', border: '1px solid #222' }}
          >
            {cueOutEvents.map(evt => {
              const firstTs = events[events.length - 1]?.timestamp ?? evt.timestamp;
              const relStart = (evt.timestamp - firstTs) / (eventDurationSec * 1000);
              const relWidth = (evt.duration ?? 30) / eventDurationSec;
              return (
                <div
                  key={evt.breakId}
                  className="absolute top-0 h-full"
                  style={{
                    left:  `${Math.max(0, Math.min(relStart * 100, 98))}%`,
                    width: `${Math.max(1, Math.min(relWidth * 100, 100))}%`,
                    background: '#ffcc0088',
                    border: '1px solid #ffcc00',
                  }}
                  title={`${evt.breakId} — ${evt.duration}s`}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Event list */}
      <div className="overflow-y-auto flex-1">
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
            <div style={{ fontSize: 32, opacity: 0.12 }}>⊘</div>
            <div className="text-noc-muted" style={{ fontSize: 12 }}>No operational events</div>
            <div className="text-noc-muted" style={{ fontSize: 11, opacity: 0.6 }}>
              SCTE-35 signals and failover transitions will appear here
            </div>
          </div>
        ) : (
          events.map((evt, i) =>
            evt.type === 'scte35'
              ? <ScteRow    key={`${evt.type}-${evt.timestamp}`} event={evt} index={i} />
              : <FailoverRow key={`${evt.type}-${evt.timestamp}`} event={evt} index={i} />
          )
        )}
      </div>

      {/* Footer stats */}
      {events.length > 0 && (
        <div
          className="flex items-center gap-5 px-4 py-3 border-t border-noc-border shrink-0"
          style={{ background: '#0e0e0e' }}
        >
          <div className="flex items-center gap-2">
            <span className="text-noc-muted" style={{ fontSize: 11 }}>AD BREAKS</span>
            <span className="text-noc-yellow tabular-nums font-bold" style={{ fontSize: 12 }}>{cueOutEvents.length}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-noc-muted" style={{ fontSize: 11 }}>AD TIME</span>
            <span className="text-noc-yellow tabular-nums font-bold" style={{ fontSize: 12 }}>
              {cueOutEvents.reduce((acc, e) => acc + (e.duration ?? 0), 0)}s
            </span>
          </div>
          {failoverEvents.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-noc-muted" style={{ fontSize: 11 }}>FAILOVERS</span>
              <span style={{ color: '#ff4444', fontSize: 12 }} className="tabular-nums font-bold">{
                failoverEvents.filter(e => e.to === 'FAILOVER').length
              }</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
