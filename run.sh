#!/usr/bin/env bash
# 本地启动像素旋转对照窗。
# 用法: ./run.sh           启动 GUI
#       ./run.sh test      跑测试
#       ./run.sh cli ...   透传 CLI 参数, 如 ./run.sh cli roundtrip
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi

case "${1:-gui}" in
  gui)
    exec .venv/bin/python -m pixel_rot.cli gui
    ;;
  test)
    exec .venv/bin/python -m pytest
    ;;
  cli)
    shift
    exec .venv/bin/python -m pixel_rot.cli "$@"
    ;;
  *)
    exec .venv/bin/python -m pixel_rot.cli "$@"
    ;;
esac
