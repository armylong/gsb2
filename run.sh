#!/usr/bin/env bash
# Local launcher: uses .venv if present, otherwise the active python3.
set -euo pipefail
cd "$(dirname "$0")"
if [[ -x .venv/bin/python ]]; then
  PY=.venv/bin/python
else
  PY=python3
fi
exec "$PY" -m mesh_warp.app "$@"
