#!/usr/bin/env bash
# 一键启动本地视频拼接工具 Web 界面（仅监听 127.0.0.1）
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "未找到 ffmpeg，请先安装并加入 PATH（macOS: brew install ffmpeg）" >&2
  exit 1
fi
if ! command -v ffprobe >/dev/null 2>&1; then
  echo "未找到 ffprobe，请确认 ffmpeg 已完整安装" >&2
  exit 1
fi

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8765}"
WORK_DIR="${WORK_DIR:-.videojoiner_work}"

exec python3 -m videojoiner.server --host "$HOST" --port "$PORT" --work-dir "$WORK_DIR"
