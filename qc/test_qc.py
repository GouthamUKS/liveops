"""
Unit tests for qc.py check functions.
FFmpeg/ffprobe subprocess calls are mocked so no video files are required.
"""

import json
from unittest.mock import MagicMock, patch
import pytest

# ── Loudness checks ───────────────────────────────────────────────────────────

def make_ebur128_stderr(lufs: float) -> str:
    """Minimal ebur128 filter output containing an integrated loudness line."""
    return (
        "  Integrated loudness:\n"
        f"    I:         {lufs:.1f} LUFS\n"
        "  Loudness range:\n"
        "    LRA:         6.0 LU\n"
    )


@patch("qc.run_ffmpeg_filter")
def test_loudness_within_range_passes(mock_ffmpeg):
    from qc import check_loudness
    mock_ffmpeg.return_value = make_ebur128_stderr(-23.5)
    result = check_loudness("fake.ts")
    assert result.status == "PASS"
    assert result.value == -23.5


@patch("qc.run_ffmpeg_filter")
def test_loudness_warn_threshold(mock_ffmpeg):
    from qc import check_loudness
    # -23 target, LUFS_MAX_DEV = 4 → warn > 4 dB deviation
    mock_ffmpeg.return_value = make_ebur128_stderr(-28.0)
    result = check_loudness("fake.ts")
    assert result.status == "WARN"


@patch("qc.run_ffmpeg_filter")
def test_loudness_fail_threshold(mock_ffmpeg):
    from qc import check_loudness
    # -23 target, LUFS_MAX_DEV = 4 → fail > 8 dB deviation
    mock_ffmpeg.return_value = make_ebur128_stderr(-35.0)
    result = check_loudness("fake.ts")
    assert result.status == "FAIL"


@patch("qc.run_ffmpeg_filter")
def test_loudness_near_silence_is_warn_not_fail(mock_ffmpeg):
    from qc import check_loudness
    # -70 LUFS backup slate should be WARN, not a content FAIL
    mock_ffmpeg.return_value = make_ebur128_stderr(-70.0)
    result = check_loudness("fake.ts")
    assert result.status == "WARN"
    assert "near silence" in result.detail.lower() or "test signal" in result.detail.lower()


@patch("qc.run_ffmpeg_filter")
def test_loudness_no_audio_stream_passes(mock_ffmpeg):
    from qc import check_loudness
    mock_ffmpeg.return_value = ""  # no ebur128 output — no audio
    result = check_loudness("fake.ts")
    # Should not FAIL — treat as WARN or PASS depending on implementation
    assert result.status in ("PASS", "WARN")


# ── Black level checks ────────────────────────────────────────────────────────

def make_signalstats_stdout(ymin: int, num_frames: int = 5) -> str:
    """Simulate metadata=print output with consistent YMIN across frames."""
    lines = []
    for _ in range(num_frames):
        lines.append(f"lavfi.signalstats.YMIN={ymin}")
        lines.append(f"lavfi.signalstats.YMAX=235")
        lines.append(f"lavfi.signalstats.YDIF=12")
    return "\n".join(lines) + "\n"


@patch("subprocess.run")
def test_black_level_normal_passes(mock_run):
    from qc import check_black_level
    mock_run.return_value = MagicMock(stdout=make_signalstats_stdout(18), returncode=0)
    result = check_black_level("fake.ts")
    assert result.status == "PASS"
    assert result.value == pytest.approx(18.0)


@patch("subprocess.run")
def test_black_level_violation_fails(mock_run):
    from qc import check_black_level
    # YMIN=4 across all frames — frozen black / lost signal
    mock_run.return_value = MagicMock(stdout=make_signalstats_stdout(4), returncode=0)
    result = check_black_level("fake.ts")
    assert result.status == "FAIL"


@patch("subprocess.run")
def test_black_level_borderline_is_warn(mock_run):
    from qc import check_black_level
    # YMIN=10 — above hard FAIL threshold (8) but low enough to warn (avg < 16)
    mock_run.return_value = MagicMock(stdout=make_signalstats_stdout(10), returncode=0)
    result = check_black_level("fake.ts")
    # avg YMIN=10, threshold*2=16 → WARN
    assert result.status == "WARN"


@patch("subprocess.run")
def test_black_level_no_signalstats_output_passes(mock_run):
    from qc import check_black_level
    # Empty stdout (e.g. audio-only segment)
    mock_run.return_value = MagicMock(stdout="", returncode=0)
    result = check_black_level("fake.ts")
    assert result.status == "PASS"
    assert result.value == 255.0


# ── Segment duration checks ───────────────────────────────────────────────────

def make_ffprobe_format(duration: float) -> dict:
    return {"format": {"duration": str(duration), "bit_rate": "1200000"}}


@patch("qc.run_ffprobe")
def test_duration_in_range_passes(mock_probe):
    from qc import check_duration
    mock_probe.return_value = make_ffprobe_format(5.8)
    result = check_duration("fake.ts")
    assert result.status == "PASS"
    assert result.value == pytest.approx(5.8, abs=0.001)


@patch("qc.run_ffprobe")
def test_duration_slightly_out_of_range_warns(mock_probe):
    from qc import check_duration
    mock_probe.return_value = make_ffprobe_format(7.5)  # outside 5-7s but < 14s
    result = check_duration("fake.ts")
    assert result.status == "WARN"


@patch("qc.run_ffprobe")
def test_duration_far_out_of_range_fails(mock_probe):
    from qc import check_duration
    mock_probe.return_value = make_ffprobe_format(8.5)  # > 7 * 2 = 14? No, 8.5 > 7.0 but not > 14.0
    # Let's use 15s which is > 7 * 2 = 14
    mock_probe.return_value = make_ffprobe_format(15.0)
    result = check_duration("fake.ts")
    assert result.status == "FAIL"


# ── Bitrate conformance checks ────────────────────────────────────────────────

@patch("qc.run_ffprobe")
def test_bitrate_within_20pct_passes(mock_probe):
    from qc import check_bitrate
    # target 1200 kbps, actual ~1100 kbps (8.3% deviation)
    mock_probe.return_value = {"format": {"duration": "6.0", "bit_rate": "1100000"}}
    result = check_bitrate("fake.ts", "480p")
    assert result.status == "PASS"


@patch("qc.run_ffprobe")
def test_bitrate_between_20_and_40pct_warns(mock_probe):
    from qc import check_bitrate
    # target 1200 kbps, actual ~900 kbps (25% deviation)
    mock_probe.return_value = {"format": {"duration": "6.0", "bit_rate": "900000"}}
    result = check_bitrate("fake.ts", "480p")
    assert result.status == "WARN"


@patch("qc.run_ffprobe")
def test_bitrate_outside_40pct_fails(mock_probe):
    from qc import check_bitrate
    # target 1200 kbps, actual 600 kbps (50% deviation)
    mock_probe.return_value = {"format": {"duration": "6.0", "bit_rate": "600000"}}
    result = check_bitrate("fake.ts", "480p")
    assert result.status == "FAIL"


@patch("qc.run_ffprobe")
def test_bitrate_unknown_variant_passes(mock_probe):
    from qc import check_bitrate
    mock_probe.return_value = {"format": {"duration": "6.0", "bit_rate": "800000"}}
    result = check_bitrate("fake.ts", "360p")  # not in BITRATE_TARGETS
    assert result.status == "PASS"


# ── Aggregate status ──────────────────────────────────────────────────────────

def test_aggregate_fail_wins():
    from qc import CheckResult, aggregate_status
    checks = [
        CheckResult("duration", "PASS", 6.0, "s", ""),
        CheckResult("bitrate", "WARN", 950.0, "kbits/s", ""),
        CheckResult("loudness", "FAIL", -35.0, "LUFS", ""),
    ]
    assert aggregate_status(checks) == "FAIL"


def test_aggregate_warn_wins_over_pass():
    from qc import CheckResult, aggregate_status
    checks = [
        CheckResult("duration", "PASS", 6.0, "s", ""),
        CheckResult("bitrate", "WARN", 950.0, "kbits/s", ""),
    ]
    assert aggregate_status(checks) == "WARN"


def test_aggregate_all_pass():
    from qc import CheckResult, aggregate_status
    checks = [
        CheckResult("duration", "PASS", 6.0, "s", ""),
        CheckResult("bitrate", "PASS", 1180.0, "kbits/s", ""),
    ]
    assert aggregate_status(checks) == "PASS"
