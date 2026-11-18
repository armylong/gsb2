#!/usr/bin/env bash
# 运行关键验证: 真实生成样例、真实导出并读取帧像素与时间戳。
set -euo pipefail
cd "$(dirname "$0")"

if [[ -x ".venv/bin/python" ]]; then
  PY=".venv/bin/python"
else
  PY="$(command -v python3)"
fi

export PYTHONPATH="$PWD/src:$PWD${PYTHONPATH:+:$PYTHONPATH}"
export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-offscreen}"
exec "$PY" -m unittest discover -s . -p "test_*.py" -t . -v
