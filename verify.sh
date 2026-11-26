#!/usr/bin/env bash
# 无头验证: 核心不变量(含“重排编号后图面逐像素一致”) + GUI 离屏冒烟。
set -euo pipefail
cd "$(dirname "$0")"

PY=.venv/bin/python
if [ ! -x "$PY" ]; then
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install -r requirements.txt
fi

echo "==================== 核心不变量验证 ===================="
"$PY" tools/verify.py

echo
echo "==================== GUI 离屏冒烟 ===================="
QT_QPA_PLATFORM=offscreen "$PY" tools/gui_smoke.py
