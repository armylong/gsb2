#!/bin/zsh
# Launch the APNG frame compositor on macOS using a local virtualenv.
set -euo pipefail

cd "$(dirname "$0")"
VENV="${VENV:-.venv}"

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "未找到 $VENV，正在创建虚拟环境并安装依赖…"
  python3 -m venv "$VENV"
  "$VENV/bin/python" -m pip install --upgrade pip
  "$VENV/bin/python" -m pip install -r requirements.txt
fi

exec "$VENV/bin/python" -m apng_editor "$@"
