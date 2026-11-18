#!/usr/bin/env bash
# 自动验证: 生成合成测试信号并运行全部 pytest 用例 (GUI 用 offscreen 平台)
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "[validate.sh] 未发现 .venv, 先执行 scripts/setup.sh..."
  scripts/setup.sh
fi

export QT_QPA_PLATFORM=offscreen
export PYTHONPATH="$PWD:${PYTHONPATH:-}"

echo "== 1/2 生成合成测试信号 (干净/受损, 含首尾异常) =="
.venv/bin/python -m tools.make_test_signals --outdir test_assets

echo "== 2/2 运行自动验证 =="
exec .venv/bin/python -m pytest tests/ -v "$@"
