#!/bin/zsh
# macOS 本地启动入口: ./run.sh           打开图形界面
#                   ./run.sh --demo     打开界面并自动生成/载入内置样例
#                   ./run.sh --verify   运行自动验证 (无界面)
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -x .venv/bin/python ]]; then
  echo "未找到 .venv, 正在创建虚拟环境并安装依赖…"
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  .venv/bin/python -m pip install -r requirements.txt
fi

if [[ "${1:-}" == "--verify" ]]; then
  shift
  exec .venv/bin/python verify.py "$@"
fi

exec .venv/bin/python -m dualalign "$@"
