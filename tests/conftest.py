import os
import sys
from pathlib import Path

# UI 测试无显示环境也能跑
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
