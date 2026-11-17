#!/usr/bin/env bash
# Headless verification for macOS / CI. No display server is required:
# the UI smoke tests run under Qt's offscreen platform plugin.
set -euo pipefail

cd "$(dirname "$0")"

# shellcheck disable=SC1091
source .venv/bin/activate

export QT_QPA_PLATFORM=offscreen
export PYTHONPATH="$PWD${PYTHONPATH:+:$PYTHONPATH}"

echo "==> Running full verification suite"
python -m pytest tests/ -v "$@"
