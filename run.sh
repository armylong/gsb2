#!/usr/bin/env bash
# 一键启动脚本：自动创建虚拟环境（若不存在）、安装依赖并启动桌面应用
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
    python3 -m venv .venv
    ./.venv/bin/python -m pip install --upgrade pip
    ./.venv/bin/pip install -r requirements.txt
fi

exec ./.venv/bin/python -m lens_corrector.app
