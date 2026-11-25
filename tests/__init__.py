"""测试包。

用 `python -I`（隔离模式）跑测试时 cwd 不会自动进 sys.path，
这里显式把仓库根目录加进去，保证能 import colorbook。
"""

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
