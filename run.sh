#!/usr/bin/env bash
# 本地启动脚本: 首次运行自动建 .venv 并安装依赖, 然后打开编辑器。
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "[run.sh] 创建虚拟环境 .venv ..."
  python3 -m venv .venv
fi

# 有任何依赖缺失就安装(已装时 pip 很快)
if ! .venv/bin/python -c "import PySide6, PIL" >/dev/null 2>&1; then
  echo "[run.sh] 安装依赖 PySide6 / Pillow ..."
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install -r requirements.txt
fi

exec .venv/bin/python -m idxpng "$@"
