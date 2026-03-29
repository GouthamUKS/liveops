import * as http from 'http';
import { createRtmpServer } from './rtmpServer';
import { LiveTranscoder } from './transcoder';
import { MetricsServer } from './metricsServer';
import { Scte35Manager } from './scte35';
import { ManifestInjector } from './manifestInjector';
import { FailoverMonitor } from './failover';
import { PipelineMetrics, QcResult, StreamSource, WsMessage } from './types';

const METRICS_PORT = parseInt(process.env.METRICS_PORT || '3001', 10);
const HEALTH_PORT  = parseInt(process.env.HEALTH_PORT  || '3002', 10);
const RTMP_HOST    = process.env.RTMP_HOST || '127.0.0.1';

// ── State ─────────────────────────────────────────────────────────────────────
let activeSource: StreamSource = 'none';

// ── Services ──────────────────────────────────────────────────────────────────
const metricsServer = new MetricsServer(METRICS_PORT);

const scte35 = new Scte35Manager((evt: WsMessage) => {
  metricsServer.broadcast(evt);
});

const failover = new FailoverMonitor(
  // onSwitch — called when failover/recovery triggers a source change
  (newUrl, newSource) => {
    activeSource = newSource;
    transcoder.switch(newUrl);
  },
  // onTransition — broadcast state change to NOC dashboard
  (_transition, event) => {
    metricsServer.broadcast(event);
  }
);

const injector = new ManifestInjector(scte35);
const transcoder = new LiveTranscoder();
const nms = createRtmpServer();

// ── RTMP event handlers ───────────────────────────────────────────────────────
nms.on('postPublish', (_id, streamPath, _args) => {
  console.log(`[rtmp] Stream publishing: ${streamPath}`);

  if (streamPath === '/live/primary') {
    activeSource = 'primary';
    failover.onPrimaryConnected();

    setTimeout(() => {
      // Only start if failover hasn't already switched us to backup
      if (failover.getState() !== 'FAILOVER') {
        transcoder.start(`rtmp://${RTMP_HOST}:1935/live/primary`);
        setTimeout(() => {
          injector.start();
          failover.start();
        }, 8000);
      }
    }, 2000);
  }

  if (streamPath === '/live/backup' && activeSource === 'none') {
    activeSource = 'backup';
  }
});

nms.on('donePublish', (_id, streamPath, _args) => {
  console.log(`[rtmp] Stream ended: ${streamPath}`);

  if (streamPath === '/live/primary') {
    failover.onPrimaryDisconnected();
    // Only clear activeSource if failover hasn't already switched to backup
    if (failover.getState() !== 'FAILOVER' && failover.getState() !== 'RECOVERY') {
      activeSource = 'none';
      transcoder.stop();
      injector.stop();
      failover.stop();
    }
  }

  if (streamPath === '/live/backup' && activeSource === 'backup') {
    activeSource = 'none';
  }
});

// ── Metrics emission loop (1 Hz) ──────────────────────────────────────────────
setInterval(() => {
  const ffmpeg = transcoder.getMetrics();
  const failoverState = failover.getState();

  // Derive pipeline state from both transcoder and failover monitor
  let pipelineState: PipelineMetrics['state'] = 'IDLE';
  if (transcoder.isRunning()) {
    if (failoverState === 'FAILOVER') pipelineState = 'FAILOVER';
    else if (failoverState === 'RECOVERY') pipelineState = 'RECOVERY';
    else if (failoverState === 'DEGRADED') pipelineState = 'ACTIVE'; // degraded is a warning, not a state change
    else pipelineState = 'ACTIVE';
  }

  const payload: PipelineMetrics = {
    type: 'metrics',
    timestamp: Date.now(),
    state: pipelineState,
    activeSource,
    scteState: scte35.getState(),
    ingestBitrate: ffmpeg.bitrate,
    encodingFps: ffmpeg.fps,
    encodingSpeed: ffmpeg.speed,
    segmentCount: transcoder.countSegments(),
    activeVariants: transcoder.isRunning() ? 3 : 0,
  };

  metricsServer.broadcast(payload);
}, 1000);

// ── HTTP API ──────────────────────────────────────────────────────────────────
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

const httpServer = http.createServer(async (req, res) => {
  const method = req.method ?? 'GET';
  const url    = req.url    ?? '/';

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // GET /health
  if (method === 'GET' && url === '/health') {
    return json(res, 200, {
      status: 'ok',
      transcoding: transcoder.isRunning(),
      activeSource,
      pipelineState: failover.getState(),
      scteState: scte35.getState(),
      ts: Date.now(),
    });
  }

  // POST /scte35/cue-out
  if (method === 'POST' && url === '/scte35/cue-out') {
    try {
      const body = JSON.parse(await readBody(req)) as { duration?: number; breakId?: string };
      const duration = Number(body.duration ?? 30);
      if (isNaN(duration) || duration < 5 || duration > 600) {
        return json(res, 400, { error: 'duration must be 5–600 seconds' });
      }
      const result = scte35.triggerAdBreak(duration, body.breakId);
      return json(res, 200, { ok: true, ...result });
    } catch (err) {
      return json(res, 409, { error: (err as Error).message });
    }
  }

  // POST /scte35/cue-in
  if (method === 'POST' && url === '/scte35/cue-in') {
    scte35.triggerCueIn();
    return json(res, 200, { ok: true, state: scte35.getState() });
  }

  // GET /scte35/status
  if (method === 'GET' && url === '/scte35/status') {
    return json(res, 200, { state: scte35.getState(), currentBreak: scte35.getCurrentBreak() });
  }

  // GET /scte35/log
  if (method === 'GET' && url === '/scte35/log') {
    return json(res, 200, { breaks: scte35.getLog() });
  }

  // GET /failover/status
  if (method === 'GET' && url === '/failover/status') {
    return json(res, 200, {
      state: failover.getState(),
      activeSource,
      transcoding: transcoder.isRunning(),
    });
  }

  // POST /qc/result  — receives QC payload from the qc service and fans out to WS clients
  if (method === 'POST' && url === '/qc/result') {
    try {
      const body = JSON.parse(await readBody(req)) as QcResult;
      if (body.type !== 'qc') return json(res, 400, { error: 'expected type=qc' });
      metricsServer.broadcast(body);
      console.log(`[qc] Received result: ${body.overall} (${body.variant}/${body.segment})`);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  }

  res.writeHead(404);
  res.end();
});

httpServer.listen(HEALTH_PORT, () => {
  console.log(`[api] HTTP API on port ${HEALTH_PORT}`);
});

// ── Startup ───────────────────────────────────────────────────────────────────
nms.run();
console.log('[rtmp] RTMP server started on port 1935');
console.log('[system] LiveOps Transcoder ready');

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown() {
  console.log('[system] Shutting down...');
  transcoder.stop();
  injector.stop();
  failover.stop();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
