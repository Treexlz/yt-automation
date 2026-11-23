# yt-automation: web UI + render pipeline in one image.
#   docker compose up -d   →  http://<host>:8080
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
# Python for the pipeline, ffmpeg for audio, and the libraries Chrome
# (Remotion's headless renderer) needs on Debian.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv ca-certificates ffmpeg \
      libnss3 libdbus-1-3 libatk1.0-0 libgbm1 libasound2 libxrandr2 libxkbcommon0 \
      libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 \
      libcairo2 libcups2 fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node dependencies + Remotion's headless Chrome (cached layer).
COPY video/package.json video/package-lock.json video/
RUN cd video && npm ci --no-audit --no-fund && npx remotion browser ensure

# Python dependencies (cached layer).
COPY requirements.txt .
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
ENV PATH=/opt/venv/bin:$PATH

COPY . .

ENV YT_DATA_DIR=/data \
    PORT=8080 \
    RENDER_CONCURRENCY=2 \
    PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/healthz')" || exit 1

CMD ["python3", "pipeline/web.py"]
