# LiveOps — Cloud Live Streaming Operations Platform

## Claude Code Build Prompt

> **Context for Claude:** You are building a portfolio project for a broadcast operations engineer (4 years experience in DCI theatrical mastering, OTT delivery, broadcast QC) who is applying for Netflix's Streaming Operations Engineer role. This project must demonstrate competence in **live streaming cloud infrastructure** — the primary gap in his profile. His existing projects (AWS_VideoTranscoder, Stream_Monitor, QC_Scanner) handle file-based encoding, simulated monitoring, and post-delivery QC respectively. This project is the **live pipeline that connects all of them** — it takes a live feed in, encodes it continuously, packages live HLS with SCTE-35 ad signaling, monitors it in real-time with a NOC dashboard, and handles failover when things break.

> **Quality bar:** This must be demonstrably more complex and more integrated than his other projects. His QC_Scanner has real broadcast domain knowledge (IRE, LUFS, channel mapping). His AWS_VideoTranscoder has clean IaC with CDK. His Stream_Monitor has WebSocket dashboards. This project must exceed all three in scope while incorporating concepts from each.

---

## What You're Building

A fully containerised live streaming operations platform that simulates what Netflix's Streaming Operations Engineering team actually manages during live events. Not a video player. Not a dashboard. **The entire cloud pipeline from ingest to delivery, with operational tooling.**

The system receives a live RTMP/SRT feed, transcodes it to multiple ABR variants in real-time, packages it as live HLS with sliding window playlists, injects SCTE-35 ad break markers, monitors every stage of the pipeline with a NOC-grade dashboard, and handles failover when the primary feed drops.

---

## Architecture (6 Components)

```
┌─────────────────────────────────────────────────────────────────┐
│                    EVENT ORCHESTRATION API                       │
│              (Python/Flask — lifecycle management)               │
│   POST /events → PUT /start → POST /ad-break → PUT /stop       │
└──────────┬──────────────────────────────────────────┬───────────┘
           │                                          │
           ▼                                          ▼
┌─────────────────────┐                 ┌─────────────────────────┐
│   LIVE INGEST SIM   │                 │     NOC DASHBOARD       │
│  (Docker + FFmpeg)  │                 │  (React + TypeScript)   │
│                     │                 │                         │
│  File → RTMP feed   │                 │  Pipeline health        │
│  Real-time pacing   │                 │  SCTE-35 event log      │
│  Backup slate feed  │                 │  Ingest metrics         │
└────────┬────────────┘                 │  Failover controls      │
         │ RTMP                         │  Event lifecycle        │
         ▼                              └────────▲────────────────┘
┌─────────────────────────────┐                  │ WebSocket
│   CLOUD TRANSCODER          │                  │
│  (Node.js + FFmpeg)         │──── metrics ─────┘
│                             │
│  RTMP ingest server         │
│  → 1080p / 720p / 480p     │
│  → Live HLS segments        │
│  → Sliding window m3u8     │
│  → SCTE-35 injection       │
└────────┬────────────────────┘
         │ HLS segments + manifests
         ▼
┌─────────────────────────────┐
│   ORIGIN / CDN SIM          │
│  (Nginx)                    │
│                             │
│  Serves live HLS            │
│  Segment caching            │
│  Access logging             │
└────────┬────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│   STREAM QC (inline)        │
│  (Python + FFmpeg)          │
│                             │
│  Real-time loudness (LUFS)  │
│  Black level monitoring     │
│  Bitrate conformance        │
│  Segment duration drift     │
└─────────────────────────────┘
```

---

## Component Specifications

### 1. Live Ingest Simulator (`/ingest`)

**Purpose:** Simulates a broadcast feed arriving at cloud acquisition — this is the "remote truck" or "venue encoder" that Netflix would receive from a live event venue.

**Stack:** Docker, FFmpeg, Bash

**Requirements:**
- Takes a pre-recorded MP4/MKV file and streams it as a **live RTMP feed** using FFmpeg's `-re` flag for real-time pacing
- Command: `ffmpeg -re -i input.mp4 -c copy -f flv rtmp://transcoder:1935/live/primary`
- Must also maintain a **backup slate feed** (a static image or colour bars with tone) on a second RTMP stream: `rtmp://transcoder:1935/live/backup`
- The backup feed runs continuously — it's what the pipeline switches to during failover
- Include a `docker-compose` service definition
- Environment variables: `INPUT_FILE`, `RTMP_TARGET`, `BACKUP_SLATE_IMAGE`

**Why this matters for the JD:** Demonstrates understanding of live signal acquisition. The JD requires "experience with on-premise video acquisition with partners or co-location facilities." This simulates the cloud-side receiver of that signal.

---

### 2. Cloud Transcoder & Live HLS Packager (`/transcoder`)

**Purpose:** The core of the pipeline — receives the live RTMP ingest, transcodes to multiple ABR variants in real-time, and packages as live HLS with sliding window playlists.

**Stack:** Node.js, FFmpeg (child process), TypeScript

**Requirements:**

**RTMP Ingest Server:**
- Use `node-media-server` or spawn an FFmpeg process listening on RTMP port 1935
- Accept two streams: `/live/primary` and `/live/backup`
- Track which stream is active (state machine: `PRIMARY → FAILOVER → RECOVERY → PRIMARY`)

**Real-time Transcoding:**
- FFmpeg command producing 3 ABR variants simultaneously:
  ```
  ffmpeg -i rtmp://localhost:1935/live/primary \
    -map 0:v -map 0:a -s 1920x1080 -b:v 5000k -c:v libx264 -preset veryfast -c:a aac -b:a 192k \
      -f hls -hls_time 6 -hls_list_size 10 -hls_flags delete_segments+append_list \
      -hls_segment_filename 'output/1080p/seg_%05d.ts' output/1080p/live.m3u8 \
    -map 0:v -map 0:a -s 1280x720 -b:v 2500k -c:v libx264 -preset veryfast -c:a aac -b:a 128k \
      -f hls -hls_time 6 -hls_list_size 10 -hls_flags delete_segments+append_list \
      -hls_segment_filename 'output/720p/seg_%05d.ts' output/720p/live.m3u8 \
    -map 0:v -map 0:a -s 854x480 -b:v 1200k -c:v libx264 -preset veryfast -c:a aac -b:a 96k \
      -f hls -hls_time 6 -hls_list_size 10 -hls_flags delete_segments+append_list \
      -hls_segment_filename 'output/480p/seg_%05d.ts' output/480p/live.m3u8
  ```
- Key difference from file-based HLS: **`-hls_list_size 10`** (sliding window, NOT `0`) and **no `EXT-X-ENDLIST`** — this is a live stream, not VOD
- `-hls_flags delete_segments` removes old segments to simulate real live behaviour
- Generate a **master manifest** (`master.m3u8`) pointing to all three variant playlists with correct `BANDWIDTH` and `RESOLUTION` tags

**SCTE-35 Ad Signal Injection:**
- This is the critical gap-filler. SCTE-35 markers are how live TV signals ad breaks.
- When the orchestration API triggers an ad break, inject `#EXT-X-CUE-OUT:DURATION=30` and `#EXT-X-CUE-IN` tags into the HLS manifests
- Implement a simple SCTE-35 splice_insert:
  ```
  #EXT-X-DATERANGE:ID="ad-break-001",START-DATE="2026-03-29T14:30:00.000Z",
    PLANNED-DURATION=30,SCTE35-OUT=0xFC301600000000000...
  ```
- You don't need to generate the full binary SCTE-35 payload — use the HLS tag-based approach (`EXT-X-CUE-OUT` / `EXT-X-CUE-IN`) which is what most OTT platforms actually use
- Log every SCTE-35 event with timestamp, duration, and break ID
- The NOC dashboard must display these events in real-time

**Metrics Emission:**
- Every second, emit metrics via WebSocket to the NOC dashboard:
  - Ingest bitrate (read from FFmpeg stderr parsing)
  - Segment generation rate (watch output directory for new .ts files)
  - Segment duration consistency (parse each .ts duration — should be 6.0s ± 0.5s)
  - Encoding FPS (from FFmpeg's `fps=` output)
  - Active variant count
  - Current ingest source (`primary` / `backup`)
  - SCTE-35 state (`normal` / `cue-out` / `cue-in`)
  - Pipeline latency (time from segment creation to availability on origin)

**Failover Logic:**
- Monitor the primary RTMP stream health (check if segments are being generated)
- If no new segment appears within `2 × target_duration` (12 seconds), trigger failover:
  1. Switch FFmpeg input from `primary` to `backup` RTMP stream
  2. Log the failover event with timestamp
  3. Emit `FAILOVER` state to NOC dashboard
  4. When primary returns, switch back after 3 consecutive healthy segments
- State machine: `HEALTHY → DEGRADED (1 missed segment) → FAILOVER → RECOVERY → HEALTHY`

---

### 3. Origin Server (`/origin`)

**Purpose:** Simulates a cloud origin / CDN edge that serves the live HLS to players.

**Stack:** Nginx (Docker)

**Requirements:**
- Serve the HLS output directory as static files
- CORS headers for cross-origin player access
- Cache-Control headers: `no-cache` for `.m3u8` manifests (must always be fresh), `max-age=86400` for `.ts` segments (immutable once written)
- Access logging in structured format (for operational analysis)
- Health endpoint at `/health`

---

### 4. NOC Operations Dashboard (`/dashboard`)

**Purpose:** Real-time operational monitoring dashboard — what a Streaming Operations Engineer actually stares at during a live event.

**Stack:** React 18, TypeScript, Recharts, WebSocket, Tailwind CSS

**Requirements:**

**Layout — 4 panels:**

**Panel 1: Pipeline Status (top bar)**
- Event name, current state (Pre-Event / Live / Ad Break / Post-Event)
- Pipeline health indicator (green/yellow/red)
- Current ingest source with failover indicator
- Uptime counter since event start
- Kill switch button (emergency stop)

**Panel 2: Live Metrics (left, 60%)**
- Ingest bitrate over time (line chart, 120-second window)
- Segment duration consistency (bar chart — each bar is a segment, colour-coded: green if 5.5-6.5s, yellow if 5-7s, red otherwise)
- Encoding FPS (should hover around source FPS)
- Pipeline latency (ingest-to-origin delay in ms)
- Buffer at origin (how many segments ahead)

**Panel 3: SCTE-35 Event Log (right, 40%)**
- Chronological list of all ad signal events
- Each entry: timestamp, type (CUE-OUT/CUE-IN), duration, break ID
- Visual timeline showing when ad breaks occurred relative to event duration
- Status: pending → active → completed

**Panel 4: Operational Controls (bottom)**
- **Trigger Ad Break** — sends POST to orchestration API, configurable duration (15/30/60s)
- **Kill Primary Feed** — stops the ingest simulator's primary stream (for failover testing)
- **Restore Primary Feed** — restarts it
- **Emergency Stop** — tears down the entire pipeline
- **Event Lifecycle** — buttons to transition: Provision → Start → Stop → Teardown

**Design direction:**
- Dark theme (NOC screens are always dark)
- Monospace font for metrics (operators need to scan numbers fast)
- Status colours: green (#00ff88), yellow (#ffcc00), red (#ff4444) on dark background
- Dense information layout — this is an operational tool, not a consumer app
- No decorative elements. Every pixel must convey information.
- Inspired by: Grafana dark dashboards, broadcast master control room monitors

---

### 5. Event Orchestration API (`/orchestrator`)

**Purpose:** Manages the live event lifecycle — proves understanding that live infrastructure is ephemeral (spun up for events, torn down after).

**Stack:** Python, Flask, SQLite (for event state persistence)

**Endpoints:**

```
POST   /events                    — Create event (name, scheduled_time, config)
GET    /events                    — List all events
GET    /events/:id                — Get event details + current state
PUT    /events/:id/provision      — Start containers, verify pipeline health
PUT    /events/:id/start          — Begin live ingest, start encoding
POST   /events/:id/ad-break       — Trigger SCTE-35 cue-out (body: {duration: 30})
PUT    /events/:id/stop           — End event, write EXT-X-ENDLIST
DELETE /events/:id/teardown       — Stop containers, archive logs
GET    /events/:id/health         — Pipeline health check
GET    /events/:id/metrics        — Current metrics snapshot
GET    /events/:id/scte35-log     — All SCTE-35 events for this event
```

**Event State Machine:**
```
CREATED → PROVISIONING → READY → LIVE → AD_BREAK → LIVE → STOPPING → COMPLETED → ARCHIVED
                                   ↓
                              FAILOVER → LIVE
```

**Health Checks:**
- On `/provision`: verify all containers are running, RTMP port accepting connections, origin serving 200, WebSocket connected
- On `/health`: check segment freshness (last segment < 12s old), ingest bitrate within range, no error state

---

### 6. Inline Stream QC (`/qc`)

**Purpose:** Real-time quality monitoring during the live event — extends the QC_Scanner concept from post-delivery to live.

**Stack:** Python, FFmpeg

**Requirements:**
- Periodically (every 30 seconds) sample the live HLS stream from the origin
- Run lightweight checks:
  - Audio loudness (LUFS) of last 30 seconds — flag if outside -24 ± 2 dB
  - Black level scan of last segment — flag IRE < 16 or > 235
  - Bitrate conformance — flag if actual segment bitrate deviates > 20% from target
  - Segment duration drift — flag if any segment is outside 5.0-7.0s
- Emit QC results to the NOC dashboard via the metrics WebSocket
- QC failures should show as alerts in the dashboard — yellow for warnings, red for failures
- This directly references the Zee Kannada TC rejection experience but applies it to **live monitoring** instead of post-delivery analysis

---

## Docker Compose (Full System)

```yaml
version: '3.8'

services:
  ingest-primary:
    build: ./ingest
    environment:
      - INPUT_FILE=/media/sample.mp4
      - RTMP_TARGET=rtmp://transcoder:1935/live/primary
      - MODE=primary
    volumes:
      - ./media:/media
    depends_on:
      - transcoder

  ingest-backup:
    build: ./ingest
    environment:
      - SLATE_IMAGE=/media/slate.png
      - RTMP_TARGET=rtmp://transcoder:1935/live/backup
      - MODE=backup
    volumes:
      - ./media:/media
    depends_on:
      - transcoder

  transcoder:
    build: ./transcoder
    ports:
      - "1935:1935"    # RTMP ingest
      - "3001:3001"    # Metrics WebSocket
    volumes:
      - hls-output:/output

  origin:
    build: ./origin
    ports:
      - "8080:80"
    volumes:
      - hls-output:/usr/share/nginx/html/live:ro

  qc:
    build: ./qc
    environment:
      - HLS_URL=http://origin/live/master.m3u8
      - METRICS_WS=ws://transcoder:3001
    depends_on:
      - origin

  orchestrator:
    build: ./orchestrator
    ports:
      - "5000:5000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # For container lifecycle management

  dashboard:
    build: ./dashboard
    ports:
      - "3000:3000"
    depends_on:
      - transcoder
      - orchestrator

volumes:
  hls-output:
```

---

## README Structure

**Frame this as an operations runbook, not a code walkthrough.** This is how Netflix's Streaming Ops team actually documents things.

```
# LiveOps — Cloud Live Streaming Operations Platform

## System Overview
[Architecture diagram above]
[One paragraph: what this system does and why]

## Quick Start
docker-compose up --build
# Open NOC Dashboard at http://localhost:3000
# Open HLS player at http://localhost:8080/live/master.m3u8

## Event Day Procedures
### Pre-Event Checklist
### Going Live
### Triggering Ad Breaks
### Handling Failover
### Event Teardown

## Pipeline Architecture
### Ingest Layer (RTMP Acquisition)
### Transcoding Layer (ABR Encoding)
### Packaging Layer (Live HLS)
### Origin Layer (CDN Simulation)
### Monitoring Layer (NOC Dashboard)
### QC Layer (Inline Quality Assurance)

## SCTE-35 Ad Signaling Reference
### How SCTE-35 Works in Live HLS
### Signal Flow: API → Transcoder → Manifest → Player
### Supported Signal Types

## Failover Protocol
### Detection (2× target_duration threshold)
### Switchover (primary → backup)
### Recovery (backup → primary)
### State Machine Diagram

## Operational Metrics
### Ingest Health
### Encoding Performance
### Segment Quality
### QC Alerts

## Relationship to Other Projects
- **AWS_VideoTranscoder**: Same FFmpeg encoding patterns, elevated from file-based to continuous live
- **Stream_Monitor**: NOC dashboard concept, now powered by real pipeline metrics instead of simulated data
- **QC_Scanner**: Same broadcast QC checks (IRE, LUFS), applied in real-time during live events instead of post-delivery

## Technologies & Protocols
RTMP, HLS, SCTE-35, FFmpeg, Docker, Node.js, React, Python, WebSocket, Nginx

## Author
Built by Goutham Soratoor
```

---

## Build Order (for Claude Code)

**Phase 1:** Transcoder + Origin + Ingest (get a live HLS stream working end-to-end)
**Phase 2:** NOC Dashboard (WebSocket metrics from real pipeline)
**Phase 3:** SCTE-35 injection (ad break signaling)
**Phase 4:** Failover logic (primary/backup switching)
**Phase 5:** Orchestration API (event lifecycle)
**Phase 6:** Inline QC (real-time quality monitoring)
**Phase 7:** README as operations runbook

---

## What This Proves to Netflix

| JD Requirement | How This Project Addresses It |
|---|---|
| "Manage cloud-based streaming infrastructure, including cloud acquisition, encoding, packaging, and origin" | Entire pipeline: RTMP ingest → FFmpeg transcode → HLS packaging → Nginx origin |
| "SCTE-35 & ESNI signaling" | Live SCTE-35 CUE-OUT/CUE-IN injection with event logging and dashboard visibility |
| "Experience with video transport protocols such as RTMP, HLS" | RTMP ingest, live HLS output with sliding window playlists |
| "Monitor live streaming events to ensure high-quality delivery" | NOC dashboard with real metrics from real pipeline, plus inline QC |
| "Troubleshoot, diagnose, and resolve issues related to cloud-based streaming" | Failover system, fault injection, QC alerting |
| "Be present at the NOC during live event launches" | Dashboard designed as actual NOC tooling with event lifecycle controls |
| "Lead innovation initiatives to enhance the live streaming stack" | Inline QC during live events (not just post-delivery) — novel operational approach |
| "Experience with cloud-based infrastructure" (Nice to have) | Fully containerised, Docker Compose orchestration |
| "Experience with at least one programming language" (Nice to have) | Python (orchestrator, QC), TypeScript/Node.js (transcoder), React (dashboard) |
| "Unix, shell scripting" (Nice to have) | FFmpeg command construction, Docker, bash-based ingest simulator |

---

## Honest Limitations to Acknowledge

This project uses RTMP, not SMPTE 2110 or SRT (those require specialised hardware/network config that can't be simulated locally). The SCTE-35 implementation uses HLS tag-based signaling rather than binary MPEG-TS splice_insert (the tag approach is what OTT platforms actually use, so this is defensible). It doesn't demonstrate satellite distribution or multicast — those are physical infrastructure concerns that can't be replicated in code.

**But:** It demonstrates that you understand the *operational patterns* of live streaming — ingest monitoring, real-time encoding, ad signaling, failover, and NOC-grade observability — which is what the role actually needs day-to-day.