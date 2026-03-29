import { useState, useEffect, useRef, useCallback } from 'react';
import { PipelineMetrics, OperationalEvent, QcResult, WsMessage, MetricPoint } from '../types';

const MAX_HISTORY = 120;  // 120 × 1s = 2-minute rolling window
const RECONNECT_MS = 3000;

interface MetricsSocketResult {
  connected: boolean;
  latest: PipelineMetrics | null;
  history: MetricPoint[];
  events: OperationalEvent[];  // SCTE-35 + failover events, newest first
  latestQc: QcResult | null;
}

export function useMetricsSocket(url: string): MetricsSocketResult {
  const [connected, setConnected] = useState(false);
  const [latest, setLatest] = useState<PipelineMetrics | null>(null);
  const [history, setHistory] = useState<MetricPoint[]>([]);
  const [events, setEvents] = useState<OperationalEvent[]>([]);
  const [latestQc, setLatestQc] = useState<QcResult | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        setConnected(true);
        console.log('[ws] Connected to', url);
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setConnected(false);
        console.log(`[ws] Disconnected — reconnecting in ${RECONNECT_MS}ms`);
        timerRef.current = setTimeout(connect, RECONNECT_MS);
      };

      ws.onerror = () => {
        // onclose fires after onerror — reconnect logic lives there
      };

      ws.onmessage = (evt: MessageEvent) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(evt.data as string) as WsMessage;

          if (msg.type === 'metrics') {
            setLatest(msg);
            setHistory(prev => {
              const point: MetricPoint = {
                ts: msg.timestamp,
                bitrate: msg.ingestBitrate,
                fps: msg.encodingFps,
              };
              const next = [...prev, point];
              return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
            });
          } else if (msg.type === 'scte35' || msg.type === 'failover') {
            setEvents(prev => [msg, ...prev].slice(0, 200));
          } else if (msg.type === 'qc') {
            setLatestQc(msg);
          }
        } catch {
          // malformed message — ignore
        }
      };
    } catch {
      timerRef.current = setTimeout(connect, RECONNECT_MS);
    }
  }, [url]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { connected, latest, history, events, latestQc };
}
