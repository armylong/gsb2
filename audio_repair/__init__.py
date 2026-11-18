"""本地时频选区音频修复工具。

模块划分:
- processing: 纯 NumPy/SciPy 的 STFT 选区处理 (衰减 / 邻域修补) 与边缘过渡
- document:   已确认音频状态、预览状态、撤销/重做历史、导出
- player:     基于 QAudioSink 的分段播放与统一时间指针
- widgets:    波形视图与可缩放频谱视图
- main_window / app: PySide6 界面组装
"""

__version__ = "1.0.0"
