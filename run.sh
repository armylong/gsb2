#!/usr/bin/env bash
# Local macOS launch script for the GIF inspector.
# Creates .venv on first run, installs dependencies, then starts the GUI.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "==> Creating virtual environment .venv"
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

echo "==> Ensuring dependencies are installed"
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r requirements.txt

echo "==> Launching GIF 局部帧工具"
exec python -m giftool.app
