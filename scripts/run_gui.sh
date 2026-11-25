#!/usr/bin/env bash
# 启动 GUI。可带 WAV 与标注路径:
#   ./scripts/run_gui.sh examples/short_gap.wav examples/short_gap.annotations.json
set -euo pipefail
cd "$(dirname "$0")/.."
exec .venv/bin/python -I -m pause_editor "$@"
