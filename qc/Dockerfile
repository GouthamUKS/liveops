FROM python:3.12-slim

# Install ffmpeg (includes ffprobe)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY qc.py .

CMD ["python", "-u", "qc.py"]
