#!/usr/bin/env python3
"""生成两张测试图（灰度阶梯、带细线的测试图）。

默认输出到仓库根目录 test_assets/，该目录由本工具自行生成、内容完全可控。
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lithophane.imaging import make_staircase, make_thinline, save_gray_png


def main() -> int:
    ap = argparse.ArgumentParser(description="生成灰度阶梯与细线测试图")
    ap.add_argument("--out", default=None, help="输出目录，默认 <repo>/test_assets")
    ap.add_argument("--size", type=int, default=256)
    args = ap.parse_args()

    out_dir = args.out or os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "test_assets")
    os.makedirs(out_dir, exist_ok=True)

    stair_path = os.path.join(out_dir, "staircase.png")
    thin_path = os.path.join(out_dir, "thinline.png")
    save_gray_png(stair_path, make_staircase(args.size))
    save_gray_png(thin_path, make_thinline(args.size))
    print(f"已生成:\n  {stair_path}\n  {thin_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
