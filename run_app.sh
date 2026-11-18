#!/usr/bin/env bash
# macOS 启动脚本: 优先使用仓库内 .venv, 否则回退到系统 python3。
set -euo pipefail
cd "$(dirname "$0")"

if [[ -x ".venv/bin/python" ]]; then
  PY=".venv/bin/python"
else
  PY="$(command -v python3)"
fi

export PYTHONPATH="$PWD/src${PYTHONPATH:+:$PYTHONPATH}"
exec "$PY" -m deinterlace_lab.app "$@"
