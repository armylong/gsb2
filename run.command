#!/usr/bin/env bash
# macOS 本地启动脚本。
# 用法:
#   ./run.command                 # 启动后在界面里选 A、B
#   ./run.command a.mp4 b.mp4     # 直接载入一对
set -euo pipefail

cd "$(dirname "$0")"

# 1) 依赖 ffmpeg(仅用其命令行, 不链接库)
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "未找到 ffmpeg, 请先安装: brew install ffmpeg" >&2
  exit 1
fi

# 2) 首次运行自动建虚拟环境并安装 Python 依赖
if [ ! -d ".venv" ]; then
  echo "首次运行: 创建虚拟环境并安装 PySide6 ..."
  python3 -m venv .venv
  ./.venv/bin/pip install --upgrade pip
  ./.venv/bin/pip install -r requirements.txt
fi
# 确保本项目包可被 `python -m syncplayer` 找到(已安装则为秒级 no-op)
./.venv/bin/pip install -e . -q --no-deps

# 3) 启动(传入可选的两个视频路径)
exec ./.venv/bin/python -m syncplayer "$@"
