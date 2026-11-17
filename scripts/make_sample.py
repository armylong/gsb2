#!/usr/bin/env python3
"""生成样例视频到 workspace/sample/sample.mp4 并打印默认分段。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from speedtool import sample

if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "workspace" / "sample" / "sample.mp4"
    sample.generate_sample(out)
    print(f"样例已生成: {out}")
    print("默认分段（慢/原/快）:")
    for s in sample.default_segments():
        print(f"  {s['start']:.3f} ~ {s['end']:.3f}s  @ {s['speed']}x")
