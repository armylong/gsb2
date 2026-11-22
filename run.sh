#!/usr/bin/env bash
# 本地启动伴奏移调工具 (自动使用项目虚拟环境)
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x ".venv/bin/python" ]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi
exec .venv/bin/python -m pitchshift_tool
