"""
app.py — LiveOps Event Orchestration API

Manages the full lifecycle of a live streaming event:
  CREATED → PROVISIONING → READY → LIVE → STOPPING → COMPLETED → ARCHIVED

Coordinates with the transcoder (SCTE-35 injection), origin (health),
and Docker (ingest container kill/restore for failover testing).
"""

import json
import logging
import os
import sqlite3
import uuid
from datetime import datetime, timezone

from flask import Flask, abort, jsonify, request
from flask_cors import CORS

import docker_ctrl
import pipeline

# ── App setup ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

DB_PATH     = os.environ.get("DB_PATH",     "/data/liveops.db")
ARCHIVE_DIR = os.environ.get("ARCHIVE_DIR", "/data/archive")

# ── Valid state transitions ───────────────────────────────────────────────────

TRANSITIONS: dict[str, list[str]] = {
    "CREATED":      ["PROVISIONING"],
    "PROVISIONING": ["READY", "CREATED"],
    "READY":        ["LIVE"],
    "LIVE":         ["STOPPING", "FAILOVER"],
    "FAILOVER":     ["LIVE", "STOPPING"],
    "STOPPING":     ["COMPLETED"],
    "COMPLETED":    ["ARCHIVED"],
    "ARCHIVED":     [],
}

# ── Database helpers ──────────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    os.makedirs(ARCHIVE_DIR, exist_ok=True)

    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS events (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                scheduled_time TEXT,
                config       TEXT NOT NULL DEFAULT '{}',
                state        TEXT NOT NULL DEFAULT 'CREATED',
                created_at   TEXT NOT NULL,
                started_at   TEXT,
                stopped_at   TEXT,
                archived_at  TEXT
            );

            CREATE TABLE IF NOT EXISTS scte35_events (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id     TEXT    NOT NULL REFERENCES events(id),
                break_id     TEXT    NOT NULL,
                event_type   TEXT    NOT NULL,
                duration     INTEGER,
                occurred_at  TEXT    NOT NULL
            );

            CREATE TABLE IF NOT EXISTS pipeline_events (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id     TEXT    NOT NULL REFERENCES events(id),
                event_type   TEXT    NOT NULL,
                details      TEXT    NOT NULL DEFAULT '{}',
                occurred_at  TEXT    NOT NULL
            );
        """)

    logger.info("Database initialised at %s", DB_PATH)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def short_id() -> str:
    return str(uuid.uuid4())[:8]


def event_or_404(conn: sqlite3.Connection, event_id: str) -> dict:
    row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
    if not row:
        abort(404, description=f"Event '{event_id}' not found")
    return dict(row)


def assert_state(event: dict, *allowed: str) -> None:
    if event["state"] not in allowed:
        abort(
            409,
            description=f"Event is in state '{event['state']}', "
                        f"expected one of: {', '.join(allowed)}",
        )


def log_event(conn: sqlite3.Connection, event_id: str, event_type: str, details: dict | None = None) -> None:
    conn.execute(
        "INSERT INTO pipeline_events (event_id, event_type, details, occurred_at) VALUES (?, ?, ?, ?)",
        (event_id, event_type, json.dumps(details or {}), now_iso()),
    )


# ── Error handlers ────────────────────────────────────────────────────────────

@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": str(e)}), 404


@app.errorhandler(409)
def conflict(e):
    return jsonify({"error": str(e)}), 409


@app.errorhandler(503)
def service_unavailable(e):
    return jsonify({"error": str(e)}), 503


@app.errorhandler(400)
def bad_request(e):
    return jsonify({"error": str(e)}), 400


# ── Event routes ──────────────────────────────────────────────────────────────

@app.post("/events")
def create_event():
    """Create a new live event record."""
    data = request.get_json(force=True, silent=True) or {}
    name           = data.get("name", "Unnamed Event")
    scheduled_time = data.get("scheduled_time")
    config         = json.dumps(data.get("config", {}))
    event_id       = short_id()

    with get_db() as conn:
        conn.execute(
            "INSERT INTO events (id, name, scheduled_time, config, state, created_at) "
            "VALUES (?, ?, ?, ?, 'CREATED', ?)",
            (event_id, name, scheduled_time, config, now_iso()),
        )
        log_event(conn, event_id, "EVENT_CREATED")

    logger.info("Event created: %s (%s)", event_id, name)
    return jsonify({"id": event_id, "name": name, "state": "CREATED"}), 201


@app.get("/events")
def list_events():
    """List all events, most recent first."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM events ORDER BY created_at DESC"
        ).fetchall()
    return jsonify({"events": [dict(r) for r in rows]})


@app.get("/events/<event_id>")
def get_event(event_id: str):
    """Get a single event including SCTE-35 and pipeline event counts."""
    with get_db() as conn:
        event = event_or_404(conn, event_id)
        event["scte35_count"] = conn.execute(
            "SELECT COUNT(*) FROM scte35_events WHERE event_id = ?", (event_id,)
        ).fetchone()[0]
        event["pipeline_event_count"] = conn.execute(
            "SELECT COUNT(*) FROM pipeline_events WHERE event_id = ?", (event_id,)
        ).fetchone()[0]
    return jsonify(event)


@app.put("/events/<event_id>/provision")
def provision_event(event_id: str):
    """
    Run pipeline health checks and transition CREATED → READY.
    Checks: transcoder reachable, origin serving 200.
    """
    with get_db() as conn:
        event = event_or_404(conn, event_id)
        assert_state(event, "CREATED", "READY")
        conn.execute("UPDATE events SET state = 'PROVISIONING' WHERE id = ?", (event_id,))
        log_event(conn, event_id, "PROVISION_STARTED")

    health = pipeline.check_health()

    with get_db() as conn:
        if health["overall"]:
            conn.execute("UPDATE events SET state = 'READY' WHERE id = ?", (event_id,))
            log_event(conn, event_id, "PROVISION_COMPLETE", health)
            logger.info("Event %s provisioned successfully", event_id)
            return jsonify({"state": "READY", "health": health})
        else:
            conn.execute("UPDATE events SET state = 'CREATED' WHERE id = ?", (event_id,))
            log_event(conn, event_id, "PROVISION_FAILED", health)
            logger.warning("Event %s provision failed: %s", event_id, health)
            abort(503, description="Pipeline health check failed")


@app.put("/events/<event_id>/start")
def start_event(event_id: str):
    """Transition READY → LIVE. Marks the event as on-air."""
    started = now_iso()
    with get_db() as conn:
        event = event_or_404(conn, event_id)
        assert_state(event, "READY")
        conn.execute(
            "UPDATE events SET state = 'LIVE', started_at = ? WHERE id = ?",
            (started, event_id),
        )
        log_event(conn, event_id, "EVENT_STARTED")

    logger.info("Event %s went LIVE at %s", event_id, started)
    return jsonify({"state": "LIVE", "started_at": started})


@app.post("/events/<event_id>/ad-break")
def trigger_ad_break(event_id: str):
    """
    Inject a SCTE-35 CUE-OUT signal into the live HLS manifests.
    Calls the transcoder API; records the break in the local DB.
    """
    data     = request.get_json(force=True, silent=True) or {}
    duration = int(data.get("duration", 30))

    if not (5 <= duration <= 600):
        abort(400, description="duration must be 5–600 seconds")

    with get_db() as conn:
        event = event_or_404(conn, event_id)
        assert_state(event, "LIVE", "FAILOVER")

    try:
        result   = pipeline.trigger_scte35_cue_out(duration, break_id=f"{event_id}-break")
        break_id = result.get("breakId", f"{event_id}-break")
    except Exception as exc:
        logger.error("SCTE-35 cue-out failed for event %s: %s", event_id, exc)
        abort(503, description=f"Transcoder unreachable: {exc}")

    with get_db() as conn:
        conn.execute(
            "INSERT INTO scte35_events (event_id, break_id, event_type, duration, occurred_at) "
            "VALUES (?, ?, 'CUE-OUT', ?, ?)",
            (event_id, break_id, duration, now_iso()),
        )
        log_event(conn, event_id, "AD_BREAK_TRIGGERED", {"break_id": break_id, "duration": duration})

    logger.info("Ad break injected for event %s — break=%s duration=%ds", event_id, break_id, duration)
    return jsonify({"break_id": break_id, "duration": duration, "state": "LIVE"})


@app.put("/events/<event_id>/stop")
def stop_event(event_id: str):
    """End the live event. LIVE/FAILOVER → COMPLETED."""
    stopped = now_iso()
    with get_db() as conn:
        event = event_or_404(conn, event_id)
        assert_state(event, "LIVE", "FAILOVER", "READY")
        conn.execute(
            "UPDATE events SET state = 'COMPLETED', stopped_at = ? WHERE id = ?",
            (stopped, event_id),
        )
        log_event(conn, event_id, "EVENT_STOPPED")

    logger.info("Event %s stopped at %s", event_id, stopped)
    return jsonify({"state": "COMPLETED", "stopped_at": stopped})


@app.delete("/events/<event_id>/teardown")
def teardown_event(event_id: str):
    """
    Archive the event — writes a JSON runbook log to disk,
    then transitions COMPLETED → ARCHIVED.
    """
    with get_db() as conn:
        event = event_or_404(conn, event_id)
        assert_state(event, "COMPLETED")

        scte_rows = conn.execute(
            "SELECT * FROM scte35_events WHERE event_id = ? ORDER BY occurred_at",
            (event_id,),
        ).fetchall()
        pipe_rows = conn.execute(
            "SELECT * FROM pipeline_events WHERE event_id = ? ORDER BY occurred_at",
            (event_id,),
        ).fetchall()

        archived = now_iso()
        conn.execute(
            "UPDATE events SET state = 'ARCHIVED', archived_at = ? WHERE id = ?",
            (archived, event_id),
        )
        log_event(conn, event_id, "EVENT_ARCHIVED")

    archive_path = os.path.join(ARCHIVE_DIR, f"event_{event_id}_{archived[:10]}.json")
    with open(archive_path, "w") as fh:
        json.dump(
            {
                "event":        event,
                "scte35_log":   [dict(r) for r in scte_rows],
                "pipeline_log": [dict(r) for r in pipe_rows],
                "archived_at":  archived,
            },
            fh,
            indent=2,
        )

    logger.info("Event %s archived to %s", event_id, archive_path)
    return jsonify({"state": "ARCHIVED", "archive": archive_path})


@app.get("/events/<event_id>/health")
def event_health(event_id: str):
    """Live pipeline health snapshot for a specific event."""
    with get_db() as conn:
        event_or_404(conn, event_id)
    return jsonify(pipeline.check_health())


@app.get("/events/<event_id>/metrics")
def event_metrics(event_id: str):
    """Current encoding metrics from the transcoder."""
    with get_db() as conn:
        event_or_404(conn, event_id)
    return jsonify(pipeline.get_metrics())


@app.get("/events/<event_id>/scte35-log")
def event_scte35_log(event_id: str):
    """All SCTE-35 ad break events recorded for this event."""
    with get_db() as conn:
        event_or_404(conn, event_id)
        rows = conn.execute(
            "SELECT * FROM scte35_events WHERE event_id = ? ORDER BY occurred_at DESC",
            (event_id,),
        ).fetchall()
    return jsonify({"breaks": [dict(r) for r in rows]})


# ── Emergency stop (called by dashboard kill switch) ──────────────────────────

@app.put("/events/current/stop")
def emergency_stop():
    """Stop the most recent live event — called by the NOC dashboard kill switch."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM events WHERE state IN ('LIVE', 'FAILOVER', 'READY') "
            "ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE events SET state = 'COMPLETED', stopped_at = ? WHERE id = ?",
                (now_iso(), row["id"]),
            )
            log_event(conn, row["id"], "EMERGENCY_STOP")
            logger.warning("Emergency stop: event %s", row["id"])
    return jsonify({"ok": True})


# ── Ingest container management ───────────────────────────────────────────────

@app.put("/ingest/primary/stop")
def kill_primary():
    """Stop the ingest-primary container — simulates a feed drop for failover testing."""
    result = docker_ctrl.stop_container("ingest-primary")
    logger.info("Kill primary: %s", result)
    return jsonify(result), 200 if result["ok"] else 503


@app.put("/ingest/primary/start")
def restore_primary():
    """Restart the ingest-primary container after a failover test."""
    result = docker_ctrl.start_container("ingest-primary")
    logger.info("Restore primary: %s", result)
    return jsonify(result), 200 if result["ok"] else 503


@app.get("/ingest/status")
def ingest_status():
    """Current status of both ingest containers."""
    return jsonify({
        "primary": docker_ctrl.container_status("ingest-primary"),
        "backup":  docker_ctrl.container_status("ingest-backup"),
    })


# ── System health ─────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return jsonify({"status": "ok", "service": "orchestrator"})


# ── Startup ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", 5000))
    logger.info("LiveOps Orchestrator starting on port %d", port)
    app.run(host="0.0.0.0", port=port, debug=False)
