"""chroma_inspector —— 本地短片色度平面查看器。

模块划分：
- chroma:   色度采样点位置定义、虚拟亮度坐标、色度上采样
- formats:  支持的八位平面/半平面像素格式表
- media:    ffprobe/ffmpeg 探测与原始平面抽取
- color:    YUV->RGB 重建（矩阵/范围）
- patterns: 内置验证图案短片生成
- export:   并排检查图导出
- ui:       PySide6 界面
"""

__version__ = "0.1.0"
