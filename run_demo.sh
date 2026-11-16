#!/bin/sh
# 一条命令运行完整演示（无需第三方依赖，Python 3.8+ 标准库即可）。
# 用法: ./run_demo.sh
set -e
cd "$(dirname "$0")"
exec python3 -I demo.py
