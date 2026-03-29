"""
pipeline.py — External service communication for the orchestrator.

Wraps HTTP calls to the transcoder API and origin server so app.py
stays free of networking boilerplate.
"""

import os
import requests

TRANSCODER_URL = os.environ.get("TRANSCODER_API_URL", "http://transcoder:3002")
ORIGIN_URL     = os.environ.get("ORIGIN_URL",         "http://origin")
TIMEOUT        = int(os.environ.get("PIPELINE_TIMEOUT", "5"))


# ── Health checks ─────────────────────────────────────────────────────────────

def check_health() -> dict:
    """
    Check all pipeline components and return a consolidated health report.
    Used by /provision and /events/:id/health.
    """
    result = {
        "transcoder": False,
        "origin":     False,
        "transcoding": False,
        "overall":    False,
        "details":    {},
    }

    # Transcoder API
    try:
        r = requests.get(f"{TRANSCODER_URL}/health", timeout=TIMEOUT)
        data = r.json()
        result["transcoder"]  = r.status_code == 200
        result["transcoding"] = bool(data.get("transcoding"))
        result["details"]["transcoder"] = data
    except Exception as exc:
        result["details"]["transcoder_error"] = str(exc)

    # Origin server
    try:
        r = requests.get(f"{ORIGIN_URL}/health", timeout=TIMEOUT)
        result["origin"] = r.status_code == 200
        try:
            result["details"]["origin"] = r.json()
        except Exception:
            result["details"]["origin"] = {"status": "ok"}
    except Exception as exc:
        result["details"]["origin_error"] = str(exc)

    result["overall"] = result["transcoder"] and result["origin"]
    return result


def get_metrics() -> dict:
    """Current metrics snapshot — proxied from transcoder health endpoint."""
    try:
        r = requests.get(f"{TRANSCODER_URL}/health", timeout=TIMEOUT)
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        return {"error": str(exc)}


# ── SCTE-35 ───────────────────────────────────────────────────────────────────

def trigger_scte35_cue_out(duration: int, break_id: str | None = None) -> dict:
    """
    Tell the transcoder to inject a SCTE-35 CUE-OUT tag into the live HLS
    manifests and start the ad break countdown.
    """
    payload: dict = {"duration": duration}
    if break_id:
        payload["breakId"] = break_id

    r = requests.post(
        f"{TRANSCODER_URL}/scte35/cue-out",
        json=payload,
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    return r.json()


def get_scte35_log() -> dict:
    """Fetch the SCTE-35 break log from the transcoder."""
    try:
        r = requests.get(f"{TRANSCODER_URL}/scte35/log", timeout=TIMEOUT)
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        return {"error": str(exc)}
