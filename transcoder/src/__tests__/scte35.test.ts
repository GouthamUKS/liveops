import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Scte35Manager } from '../scte35';

describe('Scte35Manager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('cue-out', () => {
    it('transitions state to cue-out and sets pending tags', () => {
      const mgr = new Scte35Manager();
      const result = mgr.triggerAdBreak(30);

      expect(mgr.getState()).toBe('cue-out');
      expect(result.breakId).toBeTruthy();
      expect(mgr.pendingCueOut).toContain('EXT-X-CUE-OUT:DURATION=30');
      expect(mgr.pendingCueOut).toContain('EXT-X-DATERANGE');
    });

    it('assigns an auto-incrementing breakId when none is supplied', () => {
      const mgr = new Scte35Manager();
      const r1 = mgr.triggerAdBreak(30);
      expect(r1.breakId).toBe('break-001');
      mgr.triggerCueIn();
      vi.advanceTimersByTime(10_100);
      const r2 = mgr.triggerAdBreak(15);
      expect(r2.breakId).toBe('break-002');
    });

    it('accepts a caller-supplied breakId', () => {
      const mgr = new Scte35Manager();
      const result = mgr.triggerAdBreak(30, 'promo-042');
      expect(result.breakId).toBe('promo-042');
    });

    it('emits a CUE-OUT event via the callback', () => {
      const events: unknown[] = [];
      const mgr = new Scte35Manager(e => events.push(e));
      mgr.triggerAdBreak(30);
      expect(events).toHaveLength(1);
      expect((events[0] as { eventType: string }).eventType).toBe('CUE-OUT');
    });
  });

  describe('auto cue-in', () => {
    it('transitions to cue-in after the configured duration', () => {
      const mgr = new Scte35Manager();
      mgr.triggerAdBreak(30);
      vi.advanceTimersByTime(30_000);
      expect(mgr.getState()).toBe('cue-in');
      expect(mgr.pendingCueIn).toBe(true);
    });

    it('does not fire before the duration has elapsed', () => {
      const mgr = new Scte35Manager();
      mgr.triggerAdBreak(30);
      vi.advanceTimersByTime(29_999);
      expect(mgr.getState()).toBe('cue-out');
    });
  });

  describe('manual cue-in', () => {
    it('immediately transitions to cue-in and cancels the auto timer', () => {
      const mgr = new Scte35Manager();
      mgr.triggerAdBreak(60);
      vi.advanceTimersByTime(10_000);
      mgr.triggerCueIn();
      expect(mgr.getState()).toBe('cue-in');
      // advancing to the original timeout should not cause a second cue-in
      vi.advanceTimersByTime(50_000);
      expect(mgr.getState()).not.toBe('cue-out'); // no re-entry
    });

    it('records cuedInAt on the break log entry', () => {
      const mgr = new Scte35Manager();
      mgr.triggerAdBreak(30);
      vi.advanceTimersByTime(5_000);
      mgr.triggerCueIn();
      const log = mgr.getLog();
      expect(log[0].cuedInAt).toBeDefined();
    });

    it('emits a CUE-IN event via the callback', () => {
      const events: Array<{ eventType: string }> = [];
      const mgr = new Scte35Manager(e => events.push(e as { eventType: string }));
      mgr.triggerAdBreak(30);
      mgr.triggerCueIn();
      const cueIn = events.find(e => e.eventType === 'CUE-IN');
      expect(cueIn).toBeDefined();
    });
  });

  describe('double cue-out rejection', () => {
    it('throws when a break is already active', () => {
      const mgr = new Scte35Manager();
      mgr.triggerAdBreak(30);
      expect(() => mgr.triggerAdBreak(15)).toThrow();
    });

    it('succeeds again after the break ends', () => {
      const mgr = new Scte35Manager();
      mgr.triggerAdBreak(30);
      mgr.triggerCueIn();
      vi.advanceTimersByTime(10_100); // wait for cue-in → normal transition
      expect(() => mgr.triggerAdBreak(15)).not.toThrow();
    });
  });

  describe('cue-in without cue-out', () => {
    it('is a no-op — does not throw or change state', () => {
      const mgr = new Scte35Manager();
      expect(() => mgr.triggerCueIn()).not.toThrow();
      expect(mgr.getState()).toBe('normal');
    });
  });

  describe('atomic tag consumption', () => {
    it('pending cue-out tags can be read then cleared', () => {
      const mgr = new Scte35Manager();
      mgr.triggerAdBreak(30);
      const tags = mgr.pendingCueOut;
      expect(tags).not.toBeNull();
      mgr.pendingCueOut = null;
      expect(mgr.pendingCueOut).toBeNull();
    });

    it('pending cue-in flag can be read then cleared', () => {
      const mgr = new Scte35Manager();
      mgr.triggerAdBreak(30);
      mgr.triggerCueIn();
      expect(mgr.pendingCueIn).toBe(true);
      mgr.pendingCueIn = false;
      expect(mgr.pendingCueIn).toBe(false);
    });

    it('acknowledgeCueIn transitions state to normal', () => {
      const mgr = new Scte35Manager();
      mgr.triggerAdBreak(30);
      mgr.triggerCueIn();
      mgr.acknowledgeCueIn();
      expect(mgr.getState()).toBe('normal');
      expect(mgr.getCurrentBreak()).toBeNull();
    });
  });
});
