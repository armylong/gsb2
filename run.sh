#!/bin/zsh
# 启动 VidGeo 图形界面；自动创建 venv 并安装依赖
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "未找到 ffmpeg，请先安装：brew install ffmpeg" >&2
  exit 1
fi

exec .venv/bin/python -m vidgeo "$@"
