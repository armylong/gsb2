#!/usr/bin/env bash
# 本地检查：无 GUI 的算法核对 + offscreen GUI/交互冒烟测试
set -euo pipefail
cd "$(dirname "$0")"

PY=.venv/bin/python
[ -x "$PY" ] || PY=python3

echo "=== 1/3 算法核对（留出格是否更接近目标值）==="
"$PY" -I tests/check_calibration.py
echo
echo "=== 2/3 交互层测试 ==="
QT_QPA_PLATFORM=offscreen "$PY" -I tests/test_interaction.py
echo
echo "=== 3/3 GUI 冒烟测试 ==="
QT_QPA_PLATFORM=offscreen "$PY" -I tests/gui_smoke.py
