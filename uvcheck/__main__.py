"""支持 `python3 -m uvcheck` 启动。"""

import argparse

from .server import serve


def main() -> None:
    parser = argparse.ArgumentParser(description="本地贴图坐标（UV）检查工具")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    serve(host=args.host, port=args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    main()
