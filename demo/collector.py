#!/usr/bin/env python3
"""本地模拟采集命令, 用于演示编排能力。只读写本地文件, 不访问网络。

模式:
  ok     --duration N   持续输出进度, N 秒后成功退出
  fail                   立即以退出码 1 失败
  flaky  --state FILE   状态文件不存在则创建并失败, 存在则成功 (演示失败后重试成功)
  tree   --duration N   派生一个子进程后一起运行 (演示取消/超时时整棵进程树被清理)
"""

import argparse
import os
import subprocess
import sys
import time


def main():
    p = argparse.ArgumentParser(description="模拟采集命令")
    p.add_argument("mode", choices=["ok", "fail", "flaky", "tree"])
    p.add_argument("--duration", type=float, default=3.0)
    p.add_argument("--state", default=None)
    args = p.parse_args()

    print("[collector] mode=%s pid=%d" % (args.mode, os.getpid()), flush=True)

    if args.mode == "fail":
        print("[collector] 模拟失败: 接口返回异常", flush=True)
        return 1

    if args.mode == "flaky":
        if args.state and not os.path.exists(args.state):
            with open(args.state, "w") as f:
                f.write("failed once\n")
            print("[collector] 首次执行模拟失败 (已记录状态文件 %s)" % args.state, flush=True)
            return 1
        print("[collector] 状态文件已存在, 本次成功", flush=True)
        return 0

    child = None
    if args.mode == "tree":
        child = subprocess.Popen([sys.executable, "-c",
                                  "import time; time.sleep(3600)"])
        print("[collector] 派生子进程 pid=%d" % child.pid, flush=True)

    try:
        steps = max(1, int(args.duration))
        for i in range(steps):
            time.sleep(1)
            print("[collector] 进度 %d/%d" % (i + 1, steps), flush=True)
        print("[collector] 完成", flush=True)
        return 0
    finally:
        if child is not None:
            try:
                child.terminate()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
