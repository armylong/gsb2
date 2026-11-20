"""pytest 引导：保证仓库根目录在 sys.path 中，兼容 `python -I` 隔离运行。"""

import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
