#!/usr/bin/env bash
# One-shot local setup + launch.  Creates .venv if missing, then starts the app.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  ./.venv/bin/pip install --upgrade pip
  ./.venv/bin/pip install -r requirements.txt
fi

exec ./.venv/bin/python app.py "$@"
