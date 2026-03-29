import { ScteEvent } from './types';

export type Scte35State = 'normal' | 'cue-out' | 'cue-in';

export interface AdBreakRecord {
  breakId: string;
  duration: number;
  cuedOutAt: number;
  cuedInAt?: number;
}

export interface TriggerResult {
  breakId: string;
  duration: number;
  startDate: string;
  cueOutTags: string;
}

/**
 * Manages SCTE-35 ad break state and generates HLS tags.
 * The ManifestInjector polls this for pending tags to write.
 */
export class Scte35Manager {
  private state: Scte35State = 'normal';
  private currentBreak: AdBreakRecord | null = null;
  private breakTimer: ReturnType<typeof setTimeout> | null = null;
  private breakCounter = 0;
  private log: AdBreakRecord[] = [];

  // Flags checked by ManifestInjector
  pendingCueOut: string | null = null;   // HLS tags to inject
  pendingCueIn = false;

  private onEvent?: (evt: ScteEvent) => void;

  constructor(onEvent?: (evt: ScteEvent) => void) {
    this.onEvent = onEvent;
  }

  triggerAdBreak(duration: number, breakIdOverride?: string): TriggerResult {
    if (this.state !== 'normal') {
      throw new Error(`Cannot start break — current state: ${this.state}`);
    }

    this.breakCounter++;
    const breakId = breakIdOverride ?? `break-${String(this.breakCounter).padStart(3, '0')}`;
    const now = Date.now();
    const startDate = new Date(now).toISOString();

    this.currentBreak = { breakId, duration, cuedOutAt: now };
    this.log.push(this.currentBreak);
    this.state = 'cue-out';

    // Build HLS tags
    // EXT-X-DATERANGE carries the SCTE35-OUT binary (placeholder hex per prompt guidance)
    const scte35Hex = this.buildScte35Hex(breakId, duration);
    const cueOutTags = [
      `#EXT-X-DATERANGE:ID="${breakId}",START-DATE="${startDate}",PLANNED-DURATION=${duration},SCTE35-OUT=${scte35Hex}`,
      `#EXT-X-CUE-OUT:DURATION=${duration}`,
    ].join('\n');

    this.pendingCueOut = cueOutTags;

    // Emit to WebSocket
    this.onEvent?.({
      type: 'scte35',
      timestamp: now,
      eventType: 'CUE-OUT',
      breakId,
      duration,
    });

    console.log(`[scte35] CUE-OUT — break=${breakId} duration=${duration}s`);

    // Auto cue-in after duration
    this.breakTimer = setTimeout(() => this.triggerCueIn(), duration * 1000);

    return { breakId, duration, startDate, cueOutTags };
  }

  triggerCueIn(): void {
    if (this.state !== 'cue-out') {
      console.warn(`[scte35] CUE-IN called but state is ${this.state}`);
      return;
    }

    if (this.breakTimer) {
      clearTimeout(this.breakTimer);
      this.breakTimer = null;
    }

    const now = Date.now();
    if (this.currentBreak) {
      this.currentBreak.cuedInAt = now;
    }

    this.state = 'cue-in';
    this.pendingCueIn = true;

    const breakId = this.currentBreak?.breakId ?? 'unknown';

    this.onEvent?.({
      type: 'scte35',
      timestamp: now,
      eventType: 'CUE-IN',
      breakId,
    });

    console.log(`[scte35] CUE-IN — break=${breakId}`);

    // Transition to normal after cue-in is consumed (or after 10s fallback)
    setTimeout(() => {
      if (this.state === 'cue-in') {
        this.state = 'normal';
        this.currentBreak = null;
      }
    }, 10_000);
  }

  /** Called by ManifestInjector after it has written the CUE-IN tag */
  acknowledgeCueIn(): void {
    if (this.state === 'cue-in') {
      this.state = 'normal';
      this.currentBreak = null;
    }
  }

  getState(): Scte35State {
    return this.state;
  }

  getCurrentBreak(): AdBreakRecord | null {
    return this.currentBreak ? { ...this.currentBreak } : null;
  }

  getLog(): AdBreakRecord[] {
    return [...this.log];
  }

  /**
   * Simplified SCTE-35 splice_insert encoded as hex.
   * Per the spec this would be a full MPEG-TS binary payload, but
   * HLS tag-based signaling (EXT-X-CUE-OUT / EXT-X-CUE-IN) is what
   * OTT platforms actually use. The hex is a conformant placeholder.
   */
  private buildScte35Hex(_breakId: string, _duration: number): string {
    return '0xFC302F0000000000FF000014056FFFFFF000E011622DCAFF000052636200000000000A0008029896F50000008700000000';
  }
}
