"""本地颜色校准工具（Python + PySide6 + numpy）。

核心算法层只依赖 numpy，GUI 层才依赖 PySide6，
这样 tests/check_calibration.py 可以在无显示环境下直接跑。
"""

__version__ = "1.0.0"
