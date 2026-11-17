"""pytest 配置：把仓库根目录加入 sys.path，支持 python -I 隔离运行。"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
