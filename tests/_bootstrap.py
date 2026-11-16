"""测试公共引导: 把仓库根目录加入 sys.path, 兼容 python -I 直接运行。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
