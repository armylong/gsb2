#!/usr/bin/env bash
# 一键验证:无头自测(处理管线关键性质)+ GUI 冒烟(offscreen 窗口交互)。
# 样例由程序内部确定性生成,无需任何外部素材。退出码 0 即全部通过。
set -euo pipefail
cd "$(dirname "$0")"

PY=.venv/bin/python
if [ ! -x "$PY" ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r requirements.txt
fi

echo "=== 1/2 处理管线无头自测 ==="
"$PY" -m lce_lab.selftest --out out

echo
echo "=== 2/2 GUI 冒烟测试(offscreen,不弹窗) ==="
QT_QPA_PLATFORM=offscreen "$PY" -m lce_lab.gui_smoke

echo
echo "验证完成。复验图像已导出到 out/ 目录。"
