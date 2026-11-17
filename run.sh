#!/usr/bin/env bash
# 一键安装依赖并启动绿幕抠像预览工具（macOS / Linux）。
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
./.venv/bin/pip install -q -r requirements.txt
exec ./.venv/bin/python -m greenscreen
