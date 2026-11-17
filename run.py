"""开发启动入口：python run.py

生产环境也可使用：flask --app backend.app:create_app run
"""

from __future__ import annotations

import argparse
import os

from backend.app import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="本地视频取帧网页")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--workspace",
        default=os.path.join(os.path.dirname(__file__), "workspace"),
        help="上传文件、任务临时文件与帧图的工作目录",
    )
    parser.add_argument(
        "--samples",
        default=os.path.join(os.path.dirname(__file__), "samples"),
        help="本地生成的样例视频目录",
    )
    args = parser.parse_args()

    app = create_app(work_root=os.path.abspath(args.workspace))
    app.config["SAMPLE_DIR"] = os.path.abspath(args.samples)
    app.run(host=args.host, port=args.port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
