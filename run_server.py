#!/usr/bin/env python3
"""启动本地任务编排服务。

用法: python3 run_server.py [--port 8000] [--flows-dir flows] [--data-dir data]
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from orchestrator.server import serve


def main():
    p = argparse.ArgumentParser(description="本地采集任务编排服务")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--flows-dir", default="flows")
    p.add_argument("--data-dir", default="data")
    p.add_argument("--max-parallel", type=int, default=None,
                   help="全局并发上限, 默认取各流程配置中的最大值")
    args = p.parse_args()
    root = os.path.dirname(os.path.abspath(__file__))
    serve(args.port,
          flows_dir=os.path.join(root, args.flows_dir),
          data_dir=os.path.join(root, args.data_dir),
          max_parallel=args.max_parallel,
          work_cwd=root)


if __name__ == "__main__":
    main()
