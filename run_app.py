"""根级垫片：支持 `python -I run_app.py`（隔离模式下 cwd 不在 sys.path）。"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from duotone.app import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
