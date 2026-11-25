#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PY="$ROOT/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  echo "[setup] creating .venv and installing requirements"
  python3 -m venv "$ROOT/.venv"
  "$ROOT/.venv/bin/python" -m pip install --upgrade pip
  "$ROOT/.venv/bin/pip" install -r "$ROOT/requirements.txt"
fi

export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-offscreen}"

echo "[1/2] unit tests"
"$PY" -m unittest discover -s tests -v

echo "[2/2] built-in end-to-end demo"
"$PY" -m subtitle_avoidance.demo --out examples/demo

echo "OK: tests and examples/demo/e2e_report.json"
