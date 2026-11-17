#!/usr/bin/env bash
# 一键运行全部自动化测试（纯本机，无需联网）
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  echo "缺少 ffmpeg / ffprobe，请先安装：brew install ffmpeg" >&2
  exit 1
fi

python3 -I -m unittest discover -s tests -v
