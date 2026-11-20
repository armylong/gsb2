"""根级垫片：支持 `python -I run_verify.py`（隔离模式下 cwd 不在 sys.path）。"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from duotone.verify import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
