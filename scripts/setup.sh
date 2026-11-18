#!/usr/bin/env bash
# 创建 Mac 本地虚拟环境并安装依赖 (优先 Homebrew Python 3.12, 回退 python3)
set -euo pipefail
cd "$(dirname "$0")/.."

PYBIN=""
for cand in /opt/homebrew/bin/python3.12 /usr/local/bin/python3.12 python3; do
  if command -v "$cand" >/dev/null 2>&1; then
    PYBIN="$cand"
    break
  fi
done
if [ -z "$PYBIN" ]; then
  echo "未找到 python3, 请先安装 Python 3.10+ (例如: brew install python@3.12)"
  exit 1
fi
echo "[setup] 使用解释器: $PYBIN ($($PYBIN --version))"

if [ ! -d ".venv" ]; then
  "$PYBIN" -m venv .venv
fi
.venv/bin/python -m pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
echo "[setup] 完成。运行 GUI: ./run.sh    自动验证: ./validate.sh"
