#!/usr/bin/env bash
# 启动本地 GUI 窗口。首次运行自动建 venv 并安装依赖。
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r requirements.txt
fi

exec .venv/bin/python -m lce_lab.app
