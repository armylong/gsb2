#!/usr/bin/env bash
# 启动本地取景工具：bash scripts/start.sh [--port 8765] [--no-browser]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  echo "缺少 ffmpeg / ffprobe，请先安装：brew install ffmpeg" >&2
  exit 1
fi

exec env PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}" \
  python3 -m framer.app "$@"
