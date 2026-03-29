import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock fs so the monitor never touches the real file system.
// Tests drive state transitions directly — start() is not called.
vi.mock('fs');

import { FailoverMonitor, FailoverTransition } from '../failover';
import type { StreamSource } from '../types';

type SwitchCall = { url: string; source: StreamSource };
type TransitionRecord = { from: string; to: string; reason: string; at: number };

function makeMonitor() {
  const switches: SwitchCall[] = [];
  const transitions: TransitionRecord[] = [];

  const monitor = new FailoverMonitor(
    (url, source) => switches.push({ url, source }),
    (t: FailoverTransition) =>
      transitions.push({ from: t.from, to: t.to, reason: t.reason, at: t.at }),
  );

  return { monitor, switches, transitions };
}

describe('FailoverMonitor state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in HEALTHY state', () => {
    const { monitor } = makeMonitor();
    expect(monitor.getState()).toBe('HEALTHY');
  });

  describe('HEALTHY → DEGRADED', () => {
    it('transitions when segment gap exceeds 9 seconds', () => {
      const { monitor, switches } = makeMonitor();
      // Simulate a 10-second gap since the last segment
      (monitor as any).lastSegmentAt = Date.now() - 10_000;
      (monitor as any).checkHealth();
      expect(monitor.getState()).toBe('DEGRADED');
      expect(switches).toHaveLength(0); // no switch yet
    });

    it('does not transition below the 9-second threshold', () => {
      const { monitor } = makeMonitor();
      (monitor as any).lastSegmentAt = Date.now() - 8_000;
      (monitor as any).checkHealth();
      expect(monitor.getState()).toBe('HEALTHY');
    });
  });

  describe('HEALTHY → FAILOVER', () => {
    it('transitions and switches to backup when gap exceeds 12 seconds', () => {
      const { monitor, switches, transitions } = makeMonitor();
      (monitor as any).lastSegmentAt = Date.now() - 13_000;
      (monitor as any).checkHealth();
      expect(monitor.getState()).toBe('FAILOVER');
      expect(switches).toHaveLength(1);
      expect(switches[0].source).toBe('backup');
      expect(switches[0].url).toContain('backup');
    });

    it('transitions and switches to backup on primary RTMP disconnect', () => {
      const { monitor, switches } = makeMonitor();
      monitor.onPrimaryDisconnected();
      expect(monitor.getState()).toBe('FAILOVER');
      expect(switches).toHaveLength(1);
      expect(switches[0].source).toBe('backup');
    });
  });

  describe('FAILOVER → RECOVERY', () => {
    it('transitions to RECOVERY when primary reconnects', () => {
      const { monitor } = makeMonitor();
      monitor.onPrimaryDisconnected(); // → FAILOVER
      monitor.onPrimaryConnected();    // → RECOVERY
      expect(monitor.getState()).toBe('RECOVERY');
      expect((monitor as any).recoveryCount).toBe(0);
    });
  });

  describe('RECOVERY → HEALTHY', () => {
    it('transitions to HEALTHY and switches to primary after 3 healthy segments', () => {
      const { monitor, switches } = makeMonitor();
      monitor.onPrimaryDisconnected(); // → FAILOVER
      monitor.onPrimaryConnected();    // → RECOVERY

      (monitor as any).onNewSegment(); // count = 1
      expect(monitor.getState()).toBe('RECOVERY');

      (monitor as any).onNewSegment(); // count = 2
      expect(monitor.getState()).toBe('RECOVERY');

      (monitor as any).onNewSegment(); // count = 3 → HEALTHY
      expect(monitor.getState()).toBe('HEALTHY');
      expect(switches).toHaveLength(2);
      expect(switches[1].source).toBe('primary');
    });

    it('does not switch on fewer than 3 segments', () => {
      const { monitor, switches } = makeMonitor();
      monitor.onPrimaryDisconnected();
      monitor.onPrimaryConnected();

      (monitor as any).onNewSegment();
      (monitor as any).onNewSegment();
      expect(monitor.getState()).toBe('RECOVERY');
      expect(switches).toHaveLength(1); // only the initial backup switch
    });
  });

  describe('RECOVERY aborted', () => {
    it('returns to FAILOVER and resets recovery count if primary drops again', () => {
      const { monitor, switches } = makeMonitor();
      monitor.onPrimaryDisconnected(); // → FAILOVER
      monitor.onPrimaryConnected();    // → RECOVERY

      (monitor as any).onNewSegment(); // count = 1
      monitor.onPrimaryDisconnected(); // drop mid-recovery → FAILOVER

      expect(monitor.getState()).toBe('FAILOVER');
      expect((monitor as any).recoveryCount).toBe(0);
      // second switch should still be to backup
      expect(switches[switches.length - 1].source).toBe('backup');
    });
  });

  describe('DEGRADED → HEALTHY', () => {
    it('recovers to HEALTHY when a segment arrives while DEGRADED', () => {
      const { monitor } = makeMonitor();
      (monitor as any).lastSegmentAt = Date.now() - 10_000;
      (monitor as any).checkHealth(); // → DEGRADED
      (monitor as any).onNewSegment(); // segment arrives → HEALTHY
      expect(monitor.getState()).toBe('HEALTHY');
    });
  });

  describe('event emission', () => {
    it('emits an event with from/to/reason/timestamp on every transition', () => {
      const { monitor, transitions } = makeMonitor();
      (monitor as any).lastSegmentAt = Date.now() - 10_000;
      (monitor as any).checkHealth(); // HEALTHY → DEGRADED

      expect(transitions).toHaveLength(1);
      expect(transitions[0].from).toBe('HEALTHY');
      expect(transitions[0].to).toBe('DEGRADED');
      expect(transitions[0].reason).toBeTruthy();
      expect(transitions[0].at).toBeGreaterThan(0);
    });

    it('emits events for all transitions in a full failover cycle', () => {
      const { monitor, transitions } = makeMonitor();
      monitor.onPrimaryDisconnected(); // HEALTHY → FAILOVER
      monitor.onPrimaryConnected();    // FAILOVER → RECOVERY
      (monitor as any).onNewSegment();
      (monitor as any).onNewSegment();
      (monitor as any).onNewSegment(); // RECOVERY → HEALTHY

      const states = transitions.map(t => `${t.from}→${t.to}`);
      expect(states).toContain('HEALTHY→FAILOVER');
      expect(states).toContain('FAILOVER→RECOVERY');
      expect(states).toContain('RECOVERY→HEALTHY');
    });

    it('does not re-emit FAILOVER if already in FAILOVER', () => {
      const { monitor, transitions } = makeMonitor();
      monitor.onPrimaryDisconnected(); // → FAILOVER
      monitor.onPrimaryDisconnected(); // no-op
      const failoverEvents = transitions.filter(t => t.to === 'FAILOVER');
      expect(failoverEvents).toHaveLength(1);
    });
  });
});
