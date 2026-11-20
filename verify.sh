#!/bin/zsh
# 自动验证入口: ./verify.sh         关键断言报告
#               ./verify.sh --pytest 完整 pytest
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -x .venv/bin/python ]]; then
  echo "未找到 .venv, 请先运行 ./run.sh 初始化环境" >&2
  exit 2
fi
exec .venv/bin/python verify.py "$@"
