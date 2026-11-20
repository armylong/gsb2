#!/usr/bin/env python3
"""BandViewer 启动入口。

图形界面：  python run.py
无头自检：  python run.py --selftest --outdir tmp/selftest
"""
import sys

from bandviewer.cli import main

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
