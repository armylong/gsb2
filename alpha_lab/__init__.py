"""alpha_lab — 透明 PNG 混合像素检查工具.

模块划分:
    core      纯 numpy 的混合/色彩空间数学, 不依赖 Qt, 可独立测试
    samples   程序内置样例图生成 (带半透明边缘的前景 + 双色背景)
    selftest  数值小样: 核对 over 混合、透明格式转换、色彩空间转换
    app       PySide6 图形界面
"""

__version__ = "0.1.0"
