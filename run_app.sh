#!/usr/bin/env bash
# 本地启动脚本：自动准备 venv（首次），然后启动图形界面。
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi

exec .venv/bin/python -m lithophane.app
