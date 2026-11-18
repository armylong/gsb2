#!/usr/bin/env bash
# 一键: 生成样例 -> 跑测试 -> 用样例启动播放器(macOS)。
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
  ./.venv/bin/pip install --upgrade pip
  ./.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
fi
./.venv/bin/pip install -e . -q --no-deps

./.venv/bin/python -m tools.make_samples --out samples
./.venv/bin/python -m pytest tests/ -q
exec ./.venv/bin/python -m syncplayer samples/sample_a.mp4 samples/sample_b.mp4
