"""启动入口：python3 -m framer.app [--port 8765]"""
from __future__ import annotations

import argparse
import shutil
import sys
import webbrowser

from .server import serve


def main() -> int:
    parser = argparse.ArgumentParser(description="本地横屏转竖屏取景工具")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true",
                        help="不自动打开浏览器")
    args = parser.parse_args()

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print("错误：未找到 ffmpeg / ffprobe，请先安装（macOS: brew install ffmpeg）",
              file=sys.stderr)
        return 1

    httpd = serve(port=args.port)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"取景工具已启动：{url}（Ctrl+C 退出）")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
