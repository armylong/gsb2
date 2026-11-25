#!/usr/bin/env python3
"""仓库根目录启动入口，方便直接 `python main.py` 运行。

常规方式仍是：
    pip install -r requirements.txt
    python main.py
或：
    ./run.sh
    python -m mosaic_studio
"""
import sys
from pathlib import Path

# 允许从任意当前工作目录启动，并优先使用本仓库的包。
ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from mosaic_studio.gui.app import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
