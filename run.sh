#!/usr/bin/env bash
# Mac 本地运行时频选区音频修复工具 (GUI)
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "[run.sh] 未发现 .venv, 先执行 scripts/setup.sh 创建环境..."
  scripts/setup.sh
fi

# PySide6 插件 (QtMultimedia 等) 在 venv 内可直接找到
exec .venv/bin/python -m audio_repair.app
