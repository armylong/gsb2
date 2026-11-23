#!/bin/sh
# Launch clipmend with the project virtualenv.
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "缺少 .venv，先运行：uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python numpy PySide6" >&2
  exit 1
fi
exec .venv/bin/python app.py "$@"
