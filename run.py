#!/usr/bin/env python3
"""本地启动入口：python3 run.py [--port 8765] [--no-browser]"""

import argparse
import os
import sys

# 兼容 `python3 -I run.py` 隔离模式：显式把仓库根目录加入模块搜索路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from uvcheck.server import serve


def main() -> int:
    parser = argparse.ArgumentParser(description="本地贴图坐标（UV）检查工具")
    parser.add_argument("--host", default="127.0.0.1", help="绑定地址（默认仅本机）")
    parser.add_argument("--port", type=int, default=8765, help="监听端口（默认 8765）")
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args()
    serve(host=args.host, port=args.port, open_browser=not args.no_browser)
    return 0


if __name__ == "__main__":
    sys.exit(main())
