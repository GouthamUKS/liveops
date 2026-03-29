import * as fs from 'fs';
import * as path from 'path';
import { Scte35Manager } from './scte35';

const OUTPUT_DIR = process.env.OUTPUT_DIR || '/output';
const VARIANTS = ['1080p', '720p', '480p'];
const POLL_INTERVAL_MS = 250;
// Delay after detecting manifest change — lets FFmpeg finish its write
const WRITE_SETTLE_MS = 80;

/**
 * Watches HLS variant manifests and injects SCTE-35 tags when queued.
 *
 * Strategy:
 *   - Poll all three variant manifests every 250ms via fs.watchFile
 *   - When the primary (1080p) manifest changes, check for pending SCTE-35 tags
 *   - Inject the same tags into all three manifests atomically
 *   - A one-time injection per event is correct — CUE-OUT / CUE-IN each appear
 *     once in the playlist at the segment boundary where they take effect
 */
export class ManifestInjector {
  private scte35: Scte35Manager;
  private active = false;
  private lastMtime = 0;

  constructor(scte35: Scte35Manager) {
    this.scte35 = scte35;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.watchPrimary();
    console.log('[injector] Manifest watcher started');
  }

  stop(): void {
    this.active = false;
    const primary = path.join(OUTPUT_DIR, '1080p', 'live.m3u8');
    try {
      fs.unwatchFile(primary);
    } catch {/* ignore */}
    console.log('[injector] Manifest watcher stopped');
  }

  private watchPrimary(): void {
    const primary = path.join(OUTPUT_DIR, '1080p', 'live.m3u8');

    // Wait for the file to exist before attaching the watcher
    if (!fs.existsSync(primary)) {
      setTimeout(() => { if (this.active) this.watchPrimary(); }, 1000);
      return;
    }

    fs.watchFile(primary, { interval: POLL_INTERVAL_MS, persistent: false }, (curr, prev) => {
      if (!this.active) return;
      if (curr.mtime.getTime() <= this.lastMtime) return;
      this.lastMtime = curr.mtime.getTime();
      this.onPrimaryChanged();
    });

    console.log('[injector] Watching 1080p/live.m3u8');
  }

  private onPrimaryChanged(): void {
    const cueOutTags = this.scte35.pendingCueOut;
    const cueIn = this.scte35.pendingCueIn;

    if (!cueOutTags && !cueIn) return;

    // Consume the pending flags immediately — prevent double-injection
    this.scte35.pendingCueOut = null;
    this.scte35.pendingCueIn = false;

    const tagsToInject = cueOutTags ?? '#EXT-X-CUE-IN';

    // Small settle delay — ensures FFmpeg has finished its write
    setTimeout(() => {
      for (const variant of VARIANTS) {
        const manifestPath = path.join(OUTPUT_DIR, variant, 'live.m3u8');
        this.injectTags(manifestPath, variant, tagsToInject);
      }

      if (cueIn) {
        this.scte35.acknowledgeCueIn();
      }
    }, WRITE_SETTLE_MS);
  }

  /**
   * Insert tags before the last #EXTINF entry in the manifest.
   * This places them at the segment boundary where the break begins/ends.
   */
  private injectTags(manifestPath: string, variant: string, tags: string): void {
    try {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      const lines = content.trimEnd().split('\n');

      // Find the last #EXTINF line
      let insertIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith('#EXTINF')) {
          insertIdx = i;
          break;
        }
      }

      if (insertIdx < 0) {
        console.warn(`[injector] No #EXTINF found in ${variant}/live.m3u8 — skipping`);
        return;
      }

      const tagLines = tags.split('\n').filter(Boolean);
      lines.splice(insertIdx, 0, ...tagLines);
      fs.writeFileSync(manifestPath, lines.join('\n') + '\n', 'utf-8');

      console.log(`[injector] ${variant}: injected ${tagLines[tagLines.length - 1]}`);
    } catch (err) {
      // Manifest may be in the middle of an FFmpeg write — not fatal
      console.warn(`[injector] Could not inject into ${variant}/live.m3u8:`, (err as Error).message);
    }
  }
}
