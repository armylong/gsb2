#!/usr/bin/env bash
# 本地启动: 建/复用 .venv, 装依赖, 打开检查窗口 (默认载入内置示例)。
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi

PYTHONPATH=. exec .venv/bin/python -m light_recombine.app --example "$@"
