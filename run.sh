#!/bin/sh
# 启动视频示波器
cd "$(dirname "$0")"
exec .venv/bin/python -m videoscope "$@"
