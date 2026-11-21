#!/usr/bin/env bash
# CutLab 一键启动：首次运行会创建 .venv 并安装 PySide6。
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "需要 ffmpeg / ffprobe。macOS: brew install ffmpeg" >&2
  echo "也可以设置 CUTLAB_FFMPEG / CUTLAB_FFPROBE 指向可执行文件。" >&2
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "创建虚拟环境 .venv …"
  python3 -m venv .venv
fi

if ! .venv/bin/python -c "import PySide6" >/dev/null 2>&1; then
  echo "安装 PySide6 …"
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  .venv/bin/pip install PySide6
fi

exec .venv/bin/python -m cutlab "$@"
