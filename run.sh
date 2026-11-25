#!/usr/bin/env bash
# 一键启动：首次运行自动在 .venv 中安装依赖，之后直接启动图形界面。
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x ".venv/bin/python" ]; then
  echo "[run.sh] 首次运行，创建虚拟环境并安装依赖……"
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install -r requirements.txt
fi

exec .venv/bin/python -m mosaic_studio "$@"
