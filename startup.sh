#!/bin/sh
set -eu
cd /workspace
# :8081 is QA-only — a revive must never inherit a stale built-output preview.
node scripts/preview.mjs stop || true
mkdir -p /workspace/bin
if [ ! -x /workspace/bin/yt-dlp ]; then
  curl -fsSL -o /workspace/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux" || true
  chmod +x /workspace/bin/yt-dlp 2>/dev/null || true
fi
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi
npm run dev >>/tmp/app-startup.log 2>&1 &
