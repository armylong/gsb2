#!/usr/bin/env bash
# One-time local setup: create .venv and install dependencies.
set -euo pipefail
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip setuptools
.venv/bin/python -m pip install -r requirements.txt
echo
echo "Installed. Launch with: ./run.sh"
echo "Verify with:           .venv/bin/python -m mesh_warp.cli selfcheck"
