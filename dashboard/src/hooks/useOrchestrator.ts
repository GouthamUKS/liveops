import { useState, useEffect, useCallback } from 'react';

export interface OrchestratorEvent {
  id: string;
  name: string;
  state: string;
  created_at: string;
  started_at?: string;
  stopped_at?: string;
  scte35_count?: number;
}

interface OrchestratorResult {
  event: OrchestratorEvent | null;
  available: boolean;
  loading: boolean;
  refresh: () => void;
  createEvent: (name: string) => Promise<OrchestratorEvent>;
}

// States that represent an active (non-terminal) event
const ACTIVE_STATES = new Set(['CREATED', 'PROVISIONING', 'READY', 'LIVE', 'FAILOVER', 'STOPPING']);

export function useOrchestrator(url: string): OrchestratorResult {
  const [event, setEvent] = useState<OrchestratorEvent | null>(null);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchActive = useCallback(async () => {
    try {
      const res = await fetch(`${url}/events`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { events: OrchestratorEvent[] };
      setAvailable(true);

      // Pick most recent non-terminal event
      const active = data.events.find(e => ACTIVE_STATES.has(e.state)) ?? null;
      setEvent(active);
    } catch {
      setAvailable(false);
      setEvent(null);
    } finally {
      setLoading(false);
    }
  }, [url]);

  // Re-fetch on mount, then every 10s
  useEffect(() => {
    fetchActive();
    const interval = setInterval(fetchActive, 10_000);
    return () => clearInterval(interval);
  }, [fetchActive]);

  const createEvent = useCallback(async (name: string): Promise<OrchestratorEvent> => {
    const res = await fetch(`${url}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as OrchestratorEvent;
    setEvent(data);
    return data;
  }, [url]);

  return { event, available, loading, refresh: fetchActive, createEvent };
}
