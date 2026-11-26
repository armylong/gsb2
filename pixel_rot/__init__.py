"""像素旋转对照工具。

模块划分:
- core:      调色板图像、旋转引擎、连通/孔洞统计、ROI、往返自检 (不依赖 Qt)
- sample:    内置测试图样
- exporting: 批量导出与 manifest、重开对照
- app:       PySide6 窗口
"""

__version__ = "1.0.0"
