import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { PipelineMetrics, MetricPoint, QcResult } from '../types';

interface Props {
  metrics: PipelineMetrics | null;
  history: MetricPoint[];
  latestQc: QcResult | null;
}

function MetricTile({
  label,
  value,
  unit,
  color = '#e0e0e0',
  warn,
}: {
  label: string;
  value: string | number;
  unit?: string;
  color?: string;
  warn?: boolean;
}) {
  return (
    <div
      className="flex flex-col gap-2 p-4 border border-noc-border"
      style={{ background: '#131313' }}
    >
      <span className="text-noc-muted" style={{ fontSize: 10, letterSpacing: '0.08em' }}>
        {label}
      </span>
      <span
        className="font-bold tabular-nums"
        style={{ fontSize: 26, color: warn ? '#ffcc00' : color, lineHeight: 1 }}
      >
        {value}
        {unit && (
          <span className="font-normal text-noc-muted" style={{ fontSize: 12, marginLeft: 5 }}>
            {unit}
          </span>
        )}
      </span>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="border border-noc-border text-xs font-mono"
      style={{ background: '#1a1a1a', padding: '6px 10px' }}
    >
      <div className="text-noc-muted">{label}s ago</div>
      <div style={{ color: '#00ff88' }}>{payload[0]?.value?.toFixed(0)} kbits/s</div>
    </div>
  );
}

const QC_STATUS_COLOR: Record<string, string> = {
  PASS: '#00ff88',
  WARN: '#ffcc00',
  FAIL: '#ff4444',
};

const QC_CHECK_LABELS: Record<string, string> = {
  duration:    'SEGMENT DUR',
  bitrate:     'BITRATE',
  loudness:    'LOUDNESS',
  black_level: 'BLACK LEVEL',
};

function QcPanel({ qc }: { qc: QcResult | null }) {
  if (!qc) {
    return (
      <div
        className="flex flex-col gap-3 p-4 border border-noc-border"
        style={{ background: '#131313' }}
      >
        <span className="text-noc-muted" style={{ fontSize: 10, letterSpacing: '0.08em' }}>
          INLINE QC
        </span>
        <span className="text-noc-muted" style={{ fontSize: 11 }}>waiting for first QC cycle…</span>
      </div>
    );
  }

  const overallColor = QC_STATUS_COLOR[qc.overall] ?? '#888';
  const age = Math.round((Date.now() - qc.timestamp) / 1000);

  return (
    <div
      className="flex flex-col gap-3 p-4 border border-noc-border"
      style={{ background: '#131313', borderColor: `${overallColor}33` }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-noc-muted" style={{ fontSize: 10, letterSpacing: '0.08em' }}>
          INLINE QC
        </span>
        <div className="flex items-center gap-3">
          <span
            className="font-bold px-2 py-0"
            style={{
              fontSize: 10,
              color: overallColor,
              border: `1px solid ${overallColor}55`,
              background: `${overallColor}11`,
              letterSpacing: '0.05em',
            }}
          >
            {qc.overall}
          </span>
          <span className="text-noc-muted" style={{ fontSize: 10 }}>
            {qc.variant} · {qc.segment} · {age}s ago
          </span>
        </div>
      </div>

      {/* Per-check rows */}
      <div className="flex flex-col gap-2">
        {qc.checks.map(c => {
          const color = QC_STATUS_COLOR[c.status] ?? '#888';
          return (
            <div key={c.name} className="flex items-center gap-3" style={{ fontSize: 11 }}>
              <span
                className="font-bold"
                style={{ color, minWidth: 36, letterSpacing: '0.03em' }}
              >
                {c.status}
              </span>
              <span className="text-noc-muted" style={{ minWidth: 88 }}>
                {QC_CHECK_LABELS[c.name] ?? c.name.toUpperCase()}
              </span>
              <span className="text-noc-text tabular-nums" style={{ minWidth: 80 }}>
                {c.value} {c.unit}
              </span>
              <span className="text-noc-muted truncate">{c.detail}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function LiveMetricsPanel({ metrics, history, latestQc }: Props) {
  const chartData = history.map((p, i) => ({
    t: i - history.length + 1,
    bitrate: p.bitrate,
  }));

  const speedWarn = metrics?.encodingSpeed !== undefined && metrics.encodingSpeed > 0 && metrics.encodingSpeed < 0.9;
  const fpsWarn = metrics?.encodingFps !== undefined && metrics.encodingFps > 0 && metrics.encodingFps < 20;

  const bitrateColor =
    !metrics || metrics.state === 'IDLE' ? '#333'
    : metrics.ingestBitrate === 0 ? '#ff4444'
    : '#00ff88';

  return (
    <div
      className="flex flex-col h-full p-4 gap-4 border-r border-noc-border"
      style={{ background: '#0a0a0a' }}
    >
      {/* Panel label */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-noc-muted font-bold" style={{ fontSize: 10, letterSpacing: '0.12em' }}>
          LIVE METRICS
        </span>
        {metrics?.state === 'ACTIVE' && (
          <span
            className="text-xs px-2 py-0 font-bold"
            style={{ background: '#00ff8822', color: '#00ff88', border: '1px solid #00ff8844' }}
          >
            LIVE
          </span>
        )}
      </div>

      {/* Ingest bitrate chart — grows to fill available vertical space */}
      <div className="flex flex-col gap-2 flex-1 min-h-0">
        <span className="text-noc-muted shrink-0" style={{ fontSize: 10, letterSpacing: '0.08em' }}>
          INGEST BITRATE  (2-MIN WINDOW)
        </span>
        <div className="flex-1 min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="bitrateGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#00ff88" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#00ff88" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" vertical={false} />
              <XAxis
                dataKey="t"
                tick={{ fill: '#444', fontSize: 9, fontFamily: 'monospace' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={v => v === 0 ? 'now' : v % 30 === 0 ? `${v}s` : ''}
                interval={0}
              />
              <YAxis
                tick={{ fill: '#444', fontSize: 9, fontFamily: 'monospace' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(1)}M` : `${v}k`}
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="#222" />
              <Area
                type="monotone"
                dataKey="bitrate"
                stroke={bitrateColor}
                strokeWidth={1.5}
                fill="url(#bitrateGradient)"
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-3 shrink-0">
        <MetricTile
          label="ENCODING FPS"
          value={metrics?.encodingFps?.toFixed(1) ?? '—'}
          unit="fps"
          color="#00ff88"
          warn={fpsWarn}
        />
        <MetricTile
          label="ENCODE SPEED"
          value={metrics?.encodingSpeed?.toFixed(2) ?? '—'}
          unit="×"
          color={speedWarn ? '#ffcc00' : '#e0e0e0'}
          warn={speedWarn}
        />
        <MetricTile
          label="INGEST BITRATE"
          value={metrics?.ingestBitrate
            ? metrics.ingestBitrate >= 1000
              ? `${(metrics.ingestBitrate / 1000).toFixed(2)}`
              : `${metrics.ingestBitrate.toFixed(0)}`
            : '—'}
          unit={metrics?.ingestBitrate && metrics.ingestBitrate >= 1000 ? 'Mbits/s' : 'kbits/s'}
          color="#4488ff"
        />
        <MetricTile
          label="SEGMENTS ON DISK"
          value={metrics?.segmentCount ?? '—'}
          color="#e0e0e0"
        />
      </div>

      {/* ABR variant status */}
      <div
        className="flex flex-col gap-3 p-4 border border-noc-border shrink-0"
        style={{ background: '#131313' }}
      >
        <span className="text-noc-muted" style={{ fontSize: 10, letterSpacing: '0.08em' }}>
          ABR VARIANTS
        </span>
        <div className="flex gap-4">
          {['1080p — 5 Mbps', '720p — 2.5 Mbps', '480p — 1.2 Mbps'].map((label, i) => {
            const active = (metrics?.activeVariants ?? 0) > i;
            return (
              <div key={label} className="flex items-center gap-2">
                <div
                  style={{
                    width: 7, height: 7, borderRadius: '50%',
                    background: active ? '#00ff88' : '#333',
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 12, color: active ? '#e0e0e0' : '#444' }}>{label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Inline QC */}
      <div className="shrink-0">
        <QcPanel qc={latestQc} />
      </div>
    </div>
  );
}
