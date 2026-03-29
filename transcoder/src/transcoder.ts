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
      '-nostats',
      '-progress', 'pipe:2',   // structured key=value progress → stderr; reports bitrate even with multi-output
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

  // Parse FFmpeg -progress pipe:2 output (one key=value per line).
  // A progress block ends with "progress=continue" or "progress=end".
  // Example block:
  //   fps=25.00
  //   bitrate=8748.4kbits/s
  //   out_time=00:01:20.000000
  //   speed=0.983x
  //   progress=continue
  private parseMetrics(chunk: string): void {
    for (const raw of chunk.split('\n')) {
      const line = raw.trim();
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();

      switch (key) {
        case 'fps':    { const v = parseFloat(val); if (!isNaN(v)) this.metrics.fps = v; break; }
        case 'speed':  { const v = parseFloat(val); if (!isNaN(v)) this.metrics.speed = v; break; }
        case 'out_time': { this.metrics.elapsed = val; break; }
        case 'bitrate': {
          // format: "8748.4kbits/s"
          const m = val.match(/([\d.]+)kbits\/s/);
          if (m) this.metrics.bitrate = parseFloat(m[1]);
          break;
        }
        case 'progress': {
          // block complete — fire callback
          this.onMetricsUpdate?.(this.getMetrics());
          break;
        }
      }
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
