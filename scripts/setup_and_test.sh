#!/usr/bin/env bash
# 一键建环境、装依赖、生成内置示例并跑本地验证。
# 用法: ./scripts/setup_and_test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet numpy PySide6 setuptools wheel
.venv/bin/python -m pip install --quiet --no-build-isolation -e .

mkdir -p examples
.venv/bin/python -I -m pause_editor.verify --examples examples
QT_QPA_PLATFORM=offscreen .venv/bin/python -I -m pause_editor.gui_smoke
echo
echo "全部验证通过。启动 GUI: .venv/bin/python -I -m pause_editor"
