# LiveOps

A fully containerised cloud live streaming operations platform built to demonstrate production-grade streaming infrastructure. Covers the full broadcast pipeline from RTMP ingest through ABR transcoding, HLS delivery, ad insertion, automatic failover, and stream quality control — all observable through a real-time NOC dashboard.

---

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │         EVENT ORCHESTRATION API          │
                    │   Flask + SQLite — lifecycle management  │
                    │  POST /events  PUT /start  PUT /stop     │
                    └────────────┬────────────────┬────────────┘
                                 │                │
              ┌──────────────────┘                └──────────────────┐
              v                                                       v
┌─────────────────────┐    RTMP     ┌──────────────────────┐   WebSocket
│   LIVE INGEST SIM   │ ─────────── │  CLOUD TRANSCODER    │ ──────────── NOC DASHBOARD
│  Docker + FFmpeg    │             │  Node.js + FFmpeg    │
│                     │             │                      │
│  primary: file loop │             │  RTMP ingest server  │
│  backup:  slate/    │             │  ABR: 1080p/720p/480p│
│           colourbars│             │  HLS packager        │
└─────────────────────┘             │  SCTE-35 injector    │
                                    │  Failover monitor    │
                                    └──────────┬───────────┘
                                               │ HLS segments + manifests
                                               v
                                    ┌──────────────────────┐
                                    │    ORIGIN SERVER     │
                                    │   Nginx — HLS CDN    │
                                    │   Cache headers      │
                                    │   CORS + health      │
                                    └──────────────────────┘
                                               │
                                    ┌──────────────────────┐
                                    │   INLINE STREAM QC   │
                                    │   Python + FFmpeg    │
                                    │   ebur128 / LUFS     │
                                    │   signalstats / IRE  │
                                    │   bitrate conformance│
                                    └──────────────────────┘
```

---

## Services

| Service | Technology | Purpose |
|---|---|---|
| `transcoder` | Node.js, FFmpeg, node-media-server | RTMP ingest server, ABR encoding, HLS packaging, SCTE-35 injection, failover |
| `origin` | Nginx | Serves HLS manifests and segments with correct cache headers and CORS |
| `ingest-primary` | FFmpeg, Bash | Loops a source video file as a live RTMP feed |
| `ingest-backup` | FFmpeg, Bash | Continuously streams a backup slate or colour bars |
| `orchestrator` | Python, Flask, SQLite | Event lifecycle API, Docker container control for failover testing |
| `qc` | Python, FFmpeg | Periodic inline QC checks — loudness, black level, bitrate, segment duration |
| `dashboard` | React, TypeScript, Vite, Recharts | Real-time NOC dashboard over WebSocket |

---

## Features

**Live ingest**
- Primary stream loops any `.mp4` file with `-stream_loop -1 -c copy` for zero-transcode overhead
- Backup stream runs a configurable slate image or colour bars + tone, always available for failover
- Both wait for the RTMP server health check before connecting

**ABR transcoding**
- Three simultaneous output variants: 1080p @ 5 Mbps, 720p @ 2.5 Mbps, 480p @ 1.2 Mbps
- Sliding HLS window (`-hls_list_size 10`, `delete_segments+append_list+independent_segments`)
- Master playlist written once at startup, variant playlists updated by FFmpeg

**SCTE-35 ad insertion**
- `EXT-X-CUE-OUT` / `EXT-X-CUE-IN` and `EXT-X-DATERANGE` tags injected into all three variant manifests simultaneously
- Tags are consumed atomically to prevent double-injection across manifest update cycles
- Auto cue-in fires after the configured duration; manual cue-in also available via API

**Automatic failover**
- Dual-mode detection: RTMP `donePublish` event (immediate) and segment gap polling (catches silent encoder hangs)
- State machine: `HEALTHY` -> `DEGRADED` (>9 s gap) -> `FAILOVER` (>12 s or RTMP drop) -> `RECOVERY` -> `HEALTHY`
- Recovery requires three consecutive healthy segments from primary before switching back
- All state transitions broadcast in real time over WebSocket

**Event orchestration**
- Full event lifecycle: `CREATED` -> `PROVISIONING` -> `READY` -> `LIVE` -> `STOPPING` -> `COMPLETED` -> `ARCHIVED`
- Pre-flight health check on provision: verifies transcoder API and origin are reachable
- Kill / restore ingest containers via Docker SDK for controlled failover testing
- Every event archives a JSON runbook log on teardown

**Inline stream QC**
- Runs every 30 seconds against the latest 480p segment
- Loudness: ebur128 integrated LUFS, target -23 LUFS, warn at ±4 dB, fail at ±8 dB
- Black level: signalstats YMIN, fails if all frames below IRE 8 (lost signal / frozen black)
- Bitrate conformance: ±20% of per-variant target = WARN, ±40% = FAIL
- Segment duration: 5–7 s nominal window
- Results POSTed to transcoder API and broadcast over WebSocket to dashboard

**NOC dashboard**
- 2-minute rolling bitrate chart (Recharts AreaChart, 120-point window)
- Live metric tiles: encoding FPS, encode speed, ingest bitrate, segments on disk
- ABR variant status indicators
- Inline QC status panel with per-check PASS / WARN / FAIL rows
- Ops event log: SCTE-35 cue events, failover transitions, ad break timeline
- Event lifecycle controls: PROVISION, GO LIVE, STOP, TEARDOWN
- Feed management: KILL PRIMARY / RESTORE PRIMARY
- Ad break triggers: 15 s, 30 s, 60 s
- Emergency stop button

---

## Prerequisites

- Docker Desktop (with "Allow the default Docker socket to be used" enabled — required by the orchestrator)
- `gh` CLI authenticated (only needed to recreate the repo)
- A source video file if you want real content; otherwise synthetic colour bars are used automatically

---

## Getting started

**1. Add source media (optional)**

Place any `.mp4` in `./media/sample.mp4`. If absent the primary ingest falls back to a synthetic 1920x1080 test signal.

```bash
# Generate a 60-second test clip with FFmpeg if you don't have one
ffmpeg -f lavfi -i "testsrc2=size=1920x1080:rate=25,format=yuv420p" \
       -f lavfi -i "sine=frequency=440" \
       -c:v libx264 -preset fast -b:v 3000k \
       -c:a aac -t 60 media/sample.mp4
```

**2. Start the stack**

```bash
docker compose up --build
```

First run downloads base images and compiles all services. Subsequent starts are cached and fast.

**3. Open the dashboard**

```
http://localhost:3030
```

The transcoder takes about 15 seconds to pass its health check before the ingest containers connect and encoding begins. The dashboard shows `IDLE` until the first RTMP stream is received.

---

## Port reference

| Port | Service | Protocol |
|---|---|---|
| 1935 | RTMP ingest | TCP |
| 3011 | Transcoder WebSocket metrics | WS |
| 3012 | Transcoder HTTP API | HTTP |
| 3030 | NOC dashboard | HTTP |
| 5001 | Orchestrator API | HTTP |
| 8090 | Origin HLS server | HTTP |

---

## API reference

### Transcoder (`localhost:3012`)

```
GET  /health                    Pipeline state, active source, SCTE-35 state
POST /scte35/cue-out            { "duration": 30, "breakId": "optional" }
POST /scte35/cue-in
GET  /scte35/status
GET  /scte35/log
GET  /failover/status
POST /qc/result                 Receives QC payloads from the qc service
```

### Orchestrator (`localhost:5001`)

```
POST   /events                          Create event  { "name": "..." }
GET    /events                          List all events
GET    /events/:id                      Get event + SCTE-35 count
PUT    /events/:id/provision            Health-check pipeline, CREATED -> READY
PUT    /events/:id/start                READY -> LIVE
POST   /events/:id/ad-break            { "duration": 30 }
PUT    /events/:id/stop                 LIVE -> COMPLETED
DELETE /events/:id/teardown             COMPLETED -> ARCHIVED, writes JSON log
GET    /events/:id/health
GET    /events/:id/metrics
GET    /events/:id/scte35-log
PUT    /events/current/stop             Emergency stop (dashboard kill switch)
PUT    /ingest/primary/stop             Kill primary ingest container
PUT    /ingest/primary/start            Restore primary ingest container
GET    /ingest/status
GET    /health
```

### HLS playback (`localhost:8090`)

```
/live/master.m3u8           Master playlist (1080p / 720p / 480p)
/live/1080p/live.m3u8       1080p variant playlist
/live/720p/live.m3u8        720p variant playlist
/live/480p/live.m3u8        480p variant playlist
/health                     Origin health check
```

---

## Failover walkthrough

1. Start the stack and wait for `ACTIVE` state in the dashboard
2. In the Operational Controls bar, click **KILL PRIMARY** — this stops the `ingest-primary` container via the Docker SDK
3. The failover monitor detects the RTMP disconnect and switches the transcoder to the backup RTMP URL within seconds
4. The dashboard transitions to `FAILOVER`, source badge changes to `BACKUP`
5. Click **RESTORE PRIMARY** — the container restarts and reconnects
6. The monitor enters `RECOVERY`, counts three healthy segments, then switches back to primary
7. Dashboard returns to `ACTIVE`, source badge back to `PRIMARY`

---

## SCTE-35 ad break walkthrough

1. With the pipeline `ACTIVE`, click **15s**, **30s**, or **60s** in Trigger Ad Break
2. If an orchestrator event is active (`LIVE` state), the break is routed through the orchestrator and recorded in SQLite; otherwise it goes directly to the transcoder
3. `EXT-X-CUE-OUT` and `EXT-X-DATERANGE` tags appear in all three HLS variant manifests at the next segment boundary
4. The SCTE-35 state badge appears in the status bar; the OPS EVENT LOG panel shows the CUE-OUT entry
5. After the configured duration, `EXT-X-CUE-IN` is injected automatically

---

## Project structure

```
.
├── docker-compose.yml
├── transcoder/             Node.js service — RTMP, FFmpeg, WebSocket, HTTP API
│   ├── src/
│   │   ├── index.ts        Service wiring and HTTP routes
│   │   ├── transcoder.ts   FFmpeg process management
│   │   ├── rtmpServer.ts   node-media-server wrapper
│   │   ├── metricsServer.ts WebSocket broadcast
│   │   ├── scte35.ts       Ad break state machine and tag generation
│   │   ├── manifestInjector.ts HLS manifest post-processing
│   │   ├── failover.ts     Failover state machine
│   │   └── types.ts        Shared TypeScript types
│   └── Dockerfile
├── origin/                 Nginx HLS origin server
│   ├── nginx.conf
│   └── Dockerfile
├── ingest/                 FFmpeg ingest containers (primary + backup)
│   ├── entrypoint.sh
│   └── Dockerfile
├── orchestrator/           Python Flask event orchestration API
│   ├── app.py
│   ├── pipeline.py         Transcoder + origin HTTP client
│   ├── docker_ctrl.py      Docker SDK container management
│   └── Dockerfile
├── qc/                     Python inline stream QC service
│   ├── qc.py
│   └── Dockerfile
├── dashboard/              React NOC dashboard
│   ├── src/
│   │   ├── App.tsx
│   │   ├── types.ts
│   │   ├── hooks/
│   │   │   ├── useMetricsSocket.ts
│   │   │   └── useOrchestrator.ts
│   │   └── components/
│   │       ├── PipelineStatusBar.tsx
│   │       ├── LiveMetricsPanel.tsx
│   │       ├── Scte35EventLog.tsx
│   │       └── OperationalControls.tsx
│   └── Dockerfile
└── media/                  Mount point for source video (gitignored)
```
