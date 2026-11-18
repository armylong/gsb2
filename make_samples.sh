#!/usr/bin/env bash
# 生成样例 (逐行参考 + TFF/BFF 交错片)。
set -euo pipefail
cd "$(dirname "$0")"

if [[ -x ".venv/bin/python" ]]; then
  PY=".venv/bin/python"
else
  PY="$(command -v python3)"
fi

OUT="${1:-./samples}"
export PYTHONPATH="$PWD/src${PYTHONPATH:+:$PYTHONPATH}"
exec "$PY" -m deinterlace_lab.sample_maker "$OUT"
