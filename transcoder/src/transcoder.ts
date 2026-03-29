import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FFmpegMetrics } from './types';

const OUTPUT_DIR = process.env.OUTPUT_DIR || '/output';
const HLS_TIME = 6;
const HLS_LIST_SIZE = 10;

const VARIANTS = [
  {
    name: '1080p',
    resolution: '1920x1080',
    videoBitrate: '5000k',
    audioBitrate: '192k',
    bandwidth: 5192000,
    codecs: 'avc1.640028,mp4a.40.2',
  },
  {
    name: '720p',
    resolution: '1280x720',
    videoBitrate: '2500k',
    audioBitrate: '128k',
    bandwidth: 2628000,
    codecs: 'avc1.64001f,mp4a.40.2',
  },
  {
    name: '480p',
    resolution: '854x480',
    videoBitrate: '1200k',
    audioBitrate: '96k',
    bandwidth: 1296000,
    codecs: 'avc1.64001e,mp4a.40.2',
  },
];

export class LiveTranscoder {
  private process: ChildProcess | null = null;
  private metrics: FFmpegMetrics = { bitrate: 0, fps: 0, speed: 0, elapsed: '0:00:00' };
  private onMetricsUpdate?: (m: FFmpegMetrics) => void;

  constructor(onMetricsUpdate?: (m: FFmpegMetrics) => void) {
    this.onMetricsUpdate = onMetricsUpdate;
    this.ensureOutputDirs();
    this.writeMasterManifest();
  }

  private ensureOutputDirs(): void {
    for (const v of VARIANTS) {
      fs.mkdirSync(path.join(OUTPUT_DIR, v.name), { recursive: true });
    }
    console.log(`[transcoder] Output dirs ready at ${OUTPUT_DIR}`);
  }

  private writeMasterManifest(): void {
    const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:3', ''];
    for (const v of VARIANTS) {
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.resolution},CODECS="${v.codecs}"`,
        `${v.name}/live.m3u8`,
        ''
      );
    }
    fs.writeFileSync(path.join(OUTPUT_DIR, 'master.m3u8'), lines.join('\n'));
    console.log(`[transcoder] Master manifest written`);
  }

  start(inputUrl: string): void {
    if (this.process) {
      console.log('[transcoder] Stopping existing FFmpeg process');
      this.stop();
    }

    console.log(`[transcoder] Starting FFmpeg — input: ${inputUrl}`);

    const args: string[] = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-stats',
      '-i', inputUrl,
    ];

    for (const v of VARIANTS) {
      args.push(
        '-map', '0:v', '-map', '0:a',
        '-s', v.resolution,
        '-b:v', v.videoBitrate,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-g', '48',
        '-keyint_min', '48',
        '-sc_threshold', '0',
        '-c:a', 'aac',
        '-b:a', v.audioBitrate,
        '-ar', '48000',
        '-f', 'hls',
        '-hls_time', String(HLS_TIME),
        '-hls_list_size', String(HLS_LIST_SIZE),
        '-hls_flags', 'delete_segments+append_list+independent_segments',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', path.join(OUTPUT_DIR, v.name, 'seg_%05d.ts'),
        path.join(OUTPUT_DIR, v.name, 'live.m3u8')
      );
    }

    this.process = spawn('ffmpeg', args);

    // FFmpeg writes progress to stderr
    this.process.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString();
      this.parseMetrics(line);
    });

    this.process.on('exit', (code, signal) => {
      console.log(`[transcoder] FFmpeg exited — code=${code} signal=${signal}`);
      this.process = null;
      this.metrics = { bitrate: 0, fps: 0, speed: 0, elapsed: '0:00:00' };
    });

    this.process.on('error', (err) => {
      console.error(`[transcoder] FFmpeg spawn error: ${err.message}`);
      this.process = null;
    });
  }

  // Parse FFmpeg stats line:
  // frame= 150 fps= 25 q=28.0 size=    1024kB time=00:00:06.00 bitrate=1398.1kbits/s speed=1.01x
  private parseMetrics(line: string): void {
    const fps = line.match(/fps=\s*([\d.]+)/);
    const bitrate = line.match(/bitrate=\s*([\d.]+)kbits\/s/);
    const speed = line.match(/speed=\s*([\d.]+)x/);
    const time = line.match(/time=(\d+:\d+:\d+\.\d+)/);

    let updated = false;
    if (fps) { this.metrics.fps = parseFloat(fps[1]); updated = true; }
    if (bitrate) { this.metrics.bitrate = parseFloat(bitrate[1]); updated = true; }
    if (speed) { this.metrics.speed = parseFloat(speed[1]); }
    if (time) { this.metrics.elapsed = time[1]; }

    if (updated) {
      this.onMetricsUpdate?.(this.getMetrics());
    }
  }

  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
      console.log('[transcoder] FFmpeg stopped');
    }
  }

  /**
   * Hot-switch to a new input URL (failover / recovery).
   * Stops the current FFmpeg process and restarts on the new source
   * after a short settle delay.
   */
  switch(newInputUrl: string): void {
    console.log(`[transcoder] Switching input → ${newInputUrl}`);
    this.stop();
    // Allow SIGTERM to propagate before spawning a new process
    setTimeout(() => this.start(newInputUrl), 1500);
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  getMetrics(): FFmpegMetrics {
    return { ...this.metrics };
  }

  /** Count .ts files currently on disk across all variants */
  countSegments(): number {
    let total = 0;
    for (const v of VARIANTS) {
      try {
        const files = fs.readdirSync(path.join(OUTPUT_DIR, v.name));
        total += files.filter(f => f.endsWith('.ts')).length;
      } catch {
        // dir not yet populated
      }
    }
    return total;
  }
}
