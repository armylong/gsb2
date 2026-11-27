#!/usr/bin/env bash
# 无头验证：不需要显示器，覆盖厚度方向、边框接合、STL 读回尺寸等全部关键行为。
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi

export QT_QPA_PLATFORM=offscreen
exec .venv/bin/python -I scripts/verify.py
