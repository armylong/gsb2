#!/usr/bin/env bash
# 本地启动颜色校准窗口（自动使用仓库内 .venv，不存在则创建）
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi

exec .venv/bin/python -m colorcalib
