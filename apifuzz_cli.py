#!/usr/bin/env python3
"""apifuzz 命令行入口（支持 python3 -I 隔离模式直接运行）。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from apifuzz.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
