#!/usr/bin/env python3
"""启动本地网页界面：python run.py [--port 5000]"""

import argparse
import os

from extractor.app import create_app

BASE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--data", default=os.path.join(BASE, "data"))
    args = ap.parse_args()
    os.makedirs(args.data, exist_ok=True)
    app = create_app(os.path.join(args.data, "app.db"), args.data)
    print(f"打开 http://127.0.0.1:{args.port} 使用（数据目录: {args.data}）")
    app.run(host="127.0.0.1", port=args.port, threaded=True)


if __name__ == "__main__":
    main()
