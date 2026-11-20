#!/bin/zsh
# 便捷启动：./run.sh
cd "$(dirname "$0")"
exec .venv/bin/python main.py
