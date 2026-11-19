"""测试环境：强制 Qt 使用 offscreen 后端，避免需要显示器。"""
import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
