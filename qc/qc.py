#!/usr/bin/env python3
"""
LiveOps Inline Stream QC
Runs every CHECK_INTERVAL seconds, downloads the latest QC_VARIANT segment,
and checks loudness (ebur128/LUFS), black level (signalstats/IRE),
bitrate conformance (±20%), and segment duration (5-7s).
POSTs a QcResult payload to the transcoder API.
"""

import json
import logging
import os
import re
import subprocess
import tempfile
import time
import urllib.request
import urllib.error
from dataclasses import asdict, dataclass
from typing import Optional

logging.basicConfig(
    level=logging.INFO,
    format='[qc] %(asctime)s %(levelname)s %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger(__name__)

HLS_BASE_URL      = os.environ.get('HLS_BASE_URL',      'http://origin/live')
TRANSCODER_API    = os.environ.get('TRANSCODER_API_URL', 'http://transcoder:3002')
CHECK_INTERVAL    = int(os.environ.get('CHECK_INTERVAL', '30'))
QC_VARIANT        = os.environ.get('QC_VARIANT',         '480p')

# Loudness thresholds (LUFS integrated)
LUFS_TARGET  = -23.0
LUFS_MAX_DEV =  4.0   # WARN if |measured - target| > 4, FAIL if > 8

# Black level — signalstats YMIN: 0=pure black, 255=white (8-bit)
# We flag if min luma stays below 8 for entire segment (frozen black frame / slate check)
BLACK_IRE_FAIL_THRESH = 8

# Bitrate conformance per variant (kbits/s)
BITRATE_TARGETS: dict[str, float] = {
    '1080p': 5000.0,
    '720p':  2500.0,
    '480p':  1200.0,
}
BITRATE_WARN_PCT  = 20.0   # ±20 % → WARN
BITRATE_FAIL_PCT  = 40.0   # ±40 % → FAIL

# Segment duration window (seconds)
SEGMENT_DUR_MIN  = 5.0
SEGMENT_DUR_MAX  = 7.0


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class CheckResult:
    name: str
    status: str          # PASS | WARN | FAIL
    value: float
    unit: str
    detail: str


@dataclass
class QcResult:
    type: str            # always 'qc'
    timestamp: int
    variant: str
    segment: str
    overall: str         # PASS | WARN | FAIL
    checks: list


# ── HLS helpers ───────────────────────────────────────────────────────────────

def fetch_text(url: str, timeout: int = 10) -> str:
    req = urllib.request.Request(url, headers={'User-Agent': 'LiveOps-QC/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8')


def latest_segment_url(variant: str) -> Optional[str]:
    """Parse variant playlist and return URL of the last .ts segment."""
    playlist_url = f'{HLS_BASE_URL}/{variant}/live.m3u8'
    try:
        text = fetch_text(playlist_url)
    except Exception as exc:
        log.warning('Cannot fetch playlist %s: %s', playlist_url, exc)
        return None

    segments = [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.startswith('#')
    ]
    if not segments:
        log.warning('No segments in playlist %s', playlist_url)
        return None

    seg = segments[-1]
    if seg.startswith('http'):
        return seg
    # relative URL — resolve against the playlist base
    base = playlist_url.rsplit('/', 1)[0]
    return f'{base}/{seg}'


def download_segment(url: str) -> Optional[str]:
    """Download segment to a temp file. Returns path or None."""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'LiveOps-QC/1.0'})
        with urllib.request.urlopen(req, timeout=15) as r:
            suffix = '.ts'
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(r.read())
                return tmp.name
    except Exception as exc:
        log.warning('Cannot download segment %s: %s', url, exc)
        return None


# ── ffprobe / ffmpeg helpers ──────────────────────────────────────────────────

def run_ffprobe(args: list[str]) -> Optional[dict]:
    cmd = ['ffprobe', '-v', 'quiet', '-print_format', 'json'] + args
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, timeout=30)
        return json.loads(out)
    except Exception as exc:
        log.warning('ffprobe error: %s', exc)
        return None


def run_ffmpeg_filter(path: str, vf: str = '', af: str = '') -> Optional[str]:
    """Run ffmpeg with given filters and capture stderr (where filter stats appear)."""
    cmd = ['ffmpeg', '-i', path, '-hide_banner']
    if vf:
        cmd += ['-vf', vf]
    if af:
        cmd += ['-af', af]
    cmd += ['-f', 'null', '-']
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        return result.stderr
    except Exception as exc:
        log.warning('ffmpeg filter error: %s', exc)
        return None


# ── Individual checks ─────────────────────────────────────────────────────────

def check_duration(path: str) -> CheckResult:
    data = run_ffprobe(['-show_format', path])
    if not data:
        return CheckResult('duration', 'FAIL', 0.0, 's', 'ffprobe failed')

    duration = float(data.get('format', {}).get('duration', 0))
    if SEGMENT_DUR_MIN <= duration <= SEGMENT_DUR_MAX:
        status = 'PASS'
        detail = f'{duration:.2f}s within [{SEGMENT_DUR_MIN}-{SEGMENT_DUR_MAX}]s window'
    elif duration < SEGMENT_DUR_MIN * 0.5 or duration > SEGMENT_DUR_MAX * 2:
        status = 'FAIL'
        detail = f'{duration:.2f}s outside acceptable range'
    else:
        status = 'WARN'
        detail = f'{duration:.2f}s outside nominal [{SEGMENT_DUR_MIN}-{SEGMENT_DUR_MAX}]s window'

    return CheckResult('duration', status, round(duration, 3), 's', detail)


def check_bitrate(path: str, variant: str) -> CheckResult:
    data = run_ffprobe(['-show_format', path])
    if not data:
        return CheckResult('bitrate', 'FAIL', 0.0, 'kbits/s', 'ffprobe failed')

    measured_bps = float(data.get('format', {}).get('bit_rate', 0))
    measured_kbps = measured_bps / 1000.0

    target = BITRATE_TARGETS.get(variant)
    if target is None:
        return CheckResult('bitrate', 'PASS', round(measured_kbps, 1), 'kbits/s', 'no target for variant')

    deviation_pct = abs(measured_kbps - target) / target * 100
    if deviation_pct <= BITRATE_WARN_PCT:
        status = 'PASS'
        detail = f'{measured_kbps:.0f} kbits/s ({deviation_pct:.1f}% from {target:.0f} target)'
    elif deviation_pct <= BITRATE_FAIL_PCT:
        status = 'WARN'
        detail = f'{measured_kbps:.0f} kbits/s ({deviation_pct:.1f}% deviation > {BITRATE_WARN_PCT}% threshold)'
    else:
        status = 'FAIL'
        detail = f'{measured_kbps:.0f} kbits/s ({deviation_pct:.1f}% deviation > {BITRATE_FAIL_PCT}% threshold)'

    return CheckResult('bitrate', status, round(measured_kbps, 1), 'kbits/s', detail)


def check_loudness(path: str) -> CheckResult:
    """ebur128 integrated loudness via ffmpeg loudnorm/ebur128 filter."""
    stderr = run_ffmpeg_filter(path, af='ebur128=peak=true')
    if stderr is None:
        return CheckResult('loudness', 'FAIL', 0.0, 'LUFS', 'ffmpeg failed')

    # Extract "Integrated loudness: I: -xx.x LUFS"
    match = re.search(r'I:\s*([-\d.]+)\s*LUFS', stderr)
    if not match:
        # audio track may be absent (backup slate with no audio) — treat as PASS
        if 'no audio' in stderr.lower() or 'Stream #' not in stderr:
            return CheckResult('loudness', 'PASS', 0.0, 'LUFS', 'no audio stream')
        return CheckResult('loudness', 'WARN', 0.0, 'LUFS', 'cannot parse ebur128 output')

    lufs = float(match.group(1))
    deviation = abs(lufs - LUFS_TARGET)

    if deviation <= LUFS_MAX_DEV:
        status = 'PASS'
        detail = f'{lufs:.1f} LUFS (target {LUFS_TARGET} ±{LUFS_MAX_DEV})'
    elif deviation <= LUFS_MAX_DEV * 2:
        status = 'WARN'
        detail = f'{lufs:.1f} LUFS deviates {deviation:.1f} dB from {LUFS_TARGET} target'
    else:
        status = 'FAIL'
        detail = f'{lufs:.1f} LUFS deviates {deviation:.1f} dB from {LUFS_TARGET} target'

    return CheckResult('loudness', status, round(lufs, 1), 'LUFS', detail)


def check_black_level(path: str) -> CheckResult:
    """signalstats YMIN — detect frozen black / lost signal."""
    stderr = run_ffmpeg_filter(path, vf='signalstats=stat=tout+vrep+brng')
    if stderr is None:
        # Video stream absent (audio-only) — not a failure
        return CheckResult('black_level', 'PASS', 255.0, 'IRE', 'no video stream')

    # Extract all YMIN values
    ymin_values = [float(v) for v in re.findall(r'YMIN=(\d+\.?\d*)', stderr)]
    if not ymin_values:
        return CheckResult('black_level', 'PASS', 255.0, 'IRE', 'no signalstats output (video may be absent)')

    min_ymin = min(ymin_values)
    max_ymin = max(ymin_values)
    avg_ymin = sum(ymin_values) / len(ymin_values)

    # Entire segment is near-black
    if max_ymin < BLACK_IRE_FAIL_THRESH:
        status = 'FAIL'
        detail = f'all frames black (YMIN max={max_ymin:.0f}, thresh={BLACK_IRE_FAIL_THRESH})'
    elif avg_ymin < BLACK_IRE_FAIL_THRESH * 2:
        status = 'WARN'
        detail = f'avg YMIN {avg_ymin:.1f} — possible black frames or low-level signal'
    else:
        status = 'PASS'
        detail = f'YMIN min={min_ymin:.0f} avg={avg_ymin:.1f} max={max_ymin:.0f}'

    return CheckResult('black_level', status, round(avg_ymin, 1), 'IRE', detail)


# ── Result aggregation ────────────────────────────────────────────────────────

def aggregate_status(checks: list[CheckResult]) -> str:
    statuses = {c.status for c in checks}
    if 'FAIL' in statuses:
        return 'FAIL'
    if 'WARN' in statuses:
        return 'WARN'
    return 'PASS'


# ── POST to transcoder API ────────────────────────────────────────────────────

def post_result(result: QcResult) -> None:
    url = f'{TRANSCODER_API}/qc/result'
    payload = asdict(result)
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=data,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            log.info('Posted QC result (%s) → %s %s', result.overall, url, r.status)
    except urllib.error.HTTPError as exc:
        log.warning('POST %s → HTTP %s', url, exc.code)
    except Exception as exc:
        log.warning('POST %s failed: %s', url, exc)


# ── Main loop ─────────────────────────────────────────────────────────────────

def run_check() -> None:
    seg_url = latest_segment_url(QC_VARIANT)
    if seg_url is None:
        log.info('No segment available — pipeline may be idle')
        return

    seg_name = seg_url.rsplit('/', 1)[-1]
    log.info('Checking segment: %s', seg_url)

    path = download_segment(seg_url)
    if path is None:
        log.warning('Segment download failed — skipping cycle')
        return

    try:
        checks = [
            check_duration(path),
            check_bitrate(path, QC_VARIANT),
            check_loudness(path),
            check_black_level(path),
        ]
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    overall = aggregate_status(checks)
    result = QcResult(
        type='qc',
        timestamp=int(time.time() * 1000),
        variant=QC_VARIANT,
        segment=seg_name,
        overall=overall,
        checks=[asdict(c) for c in checks],
    )

    for c in checks:
        level = logging.WARNING if c.status != 'PASS' else logging.INFO
        log.log(level, '  %-12s %-4s %s', c.name, c.status, c.detail)
    log.info('Overall: %s', overall)

    post_result(result)


def main() -> None:
    log.info('QC service starting — variant=%s interval=%ss', QC_VARIANT, CHECK_INTERVAL)
    log.info('HLS base: %s  Transcoder API: %s', HLS_BASE_URL, TRANSCODER_API)

    # Initial delay so the pipeline has time to produce segments
    time.sleep(15)

    while True:
        try:
            run_check()
        except Exception as exc:
            log.error('Unhandled error in QC cycle: %s', exc, exc_info=True)
        time.sleep(CHECK_INTERVAL)


if __name__ == '__main__':
    main()
