import * as fs from 'fs';
import * as path from 'path';
import { FailoverEvent, StreamSource } from './types';

const OUTPUT_DIR     = process.env.OUTPUT_DIR || '/output';
const RTMP_HOST      = process.env.RTMP_HOST  || '127.0.0.1';
const TARGET_DURATION_MS = 6_000;   // 6s segments
const DEGRADED_MS   = TARGET_DURATION_MS * 1.5;  // 9s  — 1 missed segment
const FAILOVER_MS   = TARGET_DURATION_MS * 2;    // 12s — hard failover threshold
const RECOVERY_SEGS = 3;   // consecutive healthy segments before switching back
const POLL_MS       = 2_000;
const MANIFEST_WATCH_MS = 500;

export type FailoverState = 'HEALTHY' | 'DEGRADED' | 'FAILOVER' | 'RECOVERY';

export interface FailoverTransition {
  from: FailoverState;
  to: FailoverState;
  reason: string;
  at: number;
}

/**
 * Monitors live pipeline health and manages primary → backup → primary switching.
 *
 * State machine:
 *   HEALTHY   — primary feed active, segments arriving on time
 *   DEGRADED  — gap > 9s (1.5× target) — alert raised, watching closely
 *   FAILOVER  — gap > 12s (2× target) or primary RTMP dropped — switched to backup
 *   RECOVERY  — primary reconnected — counting 3 healthy segments before switch-back
 */
export class FailoverMonitor {
  private state: FailoverState = 'HEALTHY';
  private lastSegmentAt: number = Date.now();
  private recoveryCount: number = 0;
  private primaryRtmpActive: boolean = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private watching: boolean = false;

  constructor(
    /** Called with the new RTMP URL when a source switch is needed */
    private readonly onSwitch: (url: string, source: StreamSource) => void,
    /** Called on every state transition (for WebSocket broadcast + logging) */
    private readonly onTransition: (transition: FailoverTransition, event: FailoverEvent) => void
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    this.lastSegmentAt = Date.now();
    this.pollTimer = setInterval(() => this.checkHealth(), POLL_MS);
    this.watchManifest();
    console.log('[failover] Monitor started');
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    const manifest = path.join(OUTPUT_DIR, '1080p', 'live.m3u8');
    try { fs.unwatchFile(manifest); } catch { /* ignore */ }
    this.watching = false;
    console.log('[failover] Monitor stopped');
  }

  // ── RTMP event hooks (called from index.ts) ────────────────────────────────

  /** Call when node-media-server fires postPublish for /live/primary */
  onPrimaryConnected(): void {
    this.primaryRtmpActive = true;
    console.log('[failover] Primary RTMP connected');

    if (this.state === 'FAILOVER') {
      this.transition('RECOVERY', 'primary stream reconnected');
      this.recoveryCount = 0;
    }
  }

  /** Call when node-media-server fires donePublish for /live/primary */
  onPrimaryDisconnected(): void {
    this.primaryRtmpActive = false;
    console.log('[failover] Primary RTMP disconnected');

    if (this.state === 'HEALTHY' || this.state === 'DEGRADED') {
      this.doFailover('primary stream disconnected');
    }
  }

  // ── Manifest watcher — segment arrival detection ──────────────────────────

  private watchManifest(): void {
    const manifest = path.join(OUTPUT_DIR, '1080p', 'live.m3u8');

    if (!fs.existsSync(manifest)) {
      setTimeout(() => { if (!this.watching) this.watchManifest(); }, 1000);
      return;
    }

    this.watching = true;

    fs.watchFile(manifest, { interval: MANIFEST_WATCH_MS, persistent: false }, (curr, prev) => {
      if (curr.mtime.getTime() > prev.mtime.getTime()) {
        this.onNewSegment();
      }
    });

    console.log('[failover] Watching segment generation');
  }

  private onNewSegment(): void {
    this.lastSegmentAt = Date.now();

    switch (this.state) {
      case 'RECOVERY':
        this.recoveryCount++;
        console.log(`[failover] Recovery segment ${this.recoveryCount}/${RECOVERY_SEGS}`);
        if (this.recoveryCount >= RECOVERY_SEGS) {
          this.switchToPrimary();
        }
        break;
      case 'DEGRADED':
        this.transition('HEALTHY', 'segment arrived — pipeline recovered');
        break;
    }
  }

  // ── Health poll ────────────────────────────────────────────────────────────

  private checkHealth(): void {
    // Only poll during normal operation states
    if (this.state === 'FAILOVER' || this.state === 'RECOVERY') return;

    const gap = Date.now() - this.lastSegmentAt;

    if (gap >= FAILOVER_MS) {
      this.doFailover(`no segment for ${(gap / 1000).toFixed(1)}s (threshold: ${FAILOVER_MS / 1000}s)`);
    } else if (gap >= DEGRADED_MS && this.state === 'HEALTHY') {
      this.transition('DEGRADED', `segment gap ${(gap / 1000).toFixed(1)}s — monitoring`);
    } else if (gap < DEGRADED_MS && this.state === 'DEGRADED') {
      this.transition('HEALTHY', 'segment gap resolved');
    }
  }

  // ── State transitions ──────────────────────────────────────────────────────

  private doFailover(reason: string): void {
    if (this.state === 'FAILOVER') return;

    this.transition('FAILOVER', reason);
    const backupUrl = `rtmp://${RTMP_HOST}:1935/live/backup`;
    console.log(`[failover] Switching to backup: ${backupUrl}`);
    this.onSwitch(backupUrl, 'backup');
  }

  private switchToPrimary(): void {
    this.recoveryCount = 0;
    this.transition('HEALTHY', `${RECOVERY_SEGS} healthy segments confirmed`);
    const primaryUrl = `rtmp://${RTMP_HOST}:1935/live/primary`;
    console.log(`[failover] Recovery complete — switching back to primary: ${primaryUrl}`);
    this.onSwitch(primaryUrl, 'primary');
  }

  private transition(to: FailoverState, reason: string): void {
    const from = this.state;
    this.state = to;

    const t: FailoverTransition = { from, to, reason, at: Date.now() };
    const event: FailoverEvent = {
      type: 'failover',
      timestamp: t.at,
      from,
      to,
      reason,
    };

    console.log(`[failover] ${from} → ${to}: ${reason}`);
    this.onTransition(t, event);
  }

  getState(): FailoverState {
    return this.state;
  }
}
