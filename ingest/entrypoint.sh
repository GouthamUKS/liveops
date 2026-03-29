#!/bin/bash
set -e

MODE=${MODE:-primary}
RTMP_TARGET=${RTMP_TARGET:-rtmp://transcoder:1935/live/primary}
INPUT_FILE=${INPUT_FILE:-/media/sample.mp4}
SLATE_IMAGE=${SLATE_IMAGE:-/media/slate.png}

# Extract host and port from RTMP URL for readiness check
RTMP_HOST=$(echo "$RTMP_TARGET" | sed 's|rtmp://||' | cut -d: -f1)
RTMP_PORT=$(echo "$RTMP_TARGET" | sed 's|rtmp://||' | cut -d: -f2 | cut -d/ -f1)
RTMP_PORT=${RTMP_PORT:-1935}

echo "[ingest] Mode: ${MODE}"
echo "[ingest] Target: ${RTMP_TARGET}"

# Wait for RTMP server to accept connections
echo "[ingest] Waiting for RTMP server at ${RTMP_HOST}:${RTMP_PORT}..."
for i in $(seq 1 30); do
    if nc -z "$RTMP_HOST" "$RTMP_PORT" 2>/dev/null; then
        echo "[ingest] RTMP server ready."
        break
    fi
    echo "[ingest] Attempt ${i}/30 — retrying in 3s..."
    sleep 3
done

if [ "$MODE" = "backup" ]; then
    if [ -f "$SLATE_IMAGE" ]; then
        echo "[ingest] Streaming slate image: ${SLATE_IMAGE}"
        exec ffmpeg -hide_banner -loglevel warning \
            -re -loop 1 -i "$SLATE_IMAGE" \
            -f lavfi -i "sine=frequency=1000:sample_rate=48000" \
            -c:v libx264 -preset veryfast -tune stillimage -b:v 500k -r 25 \
            -vf "drawtext=text='BACKUP SLATE':fontcolor=white:fontsize=48:box=1:boxcolor=black@0.5:x=(w-text_w)/2:y=(h-text_h)/2" \
            -c:a aac -b:a 64k -ar 48000 \
            -f flv "$RTMP_TARGET"
    else
        echo "[ingest] No slate image found — using colour bars + tone"
        exec ffmpeg -hide_banner -loglevel warning \
            -f lavfi -re -i "testsrc2=size=1920x1080:rate=25,format=yuv420p" \
            -f lavfi -i "sine=frequency=1000:sample_rate=48000" \
            -c:v libx264 -preset veryfast -b:v 500k \
            -c:a aac -b:a 64k -ar 48000 \
            -f flv "$RTMP_TARGET"
    fi
else
    # Primary mode
    if [ ! -f "$INPUT_FILE" ]; then
        echo "[ingest] WARNING: Input file not found: ${INPUT_FILE}"
        echo "[ingest] Falling back to synthetic test signal"
        exec ffmpeg -hide_banner -loglevel warning \
            -f lavfi -re -i "testsrc2=size=1920x1080:rate=25,format=yuv420p" \
            -f lavfi -i "sine=frequency=880:sample_rate=48000" \
            -c:v libx264 -preset veryfast -b:v 2000k \
            -c:a aac -b:a 128k -ar 48000 \
            -f flv "$RTMP_TARGET"
    fi

    echo "[ingest] Streaming ${INPUT_FILE} on loop → ${RTMP_TARGET}"
    exec ffmpeg -hide_banner -loglevel warning \
        -re -stream_loop -1 -i "$INPUT_FILE" \
        -c copy \
        -f flv "$RTMP_TARGET"
fi
