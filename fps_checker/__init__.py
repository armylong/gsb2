"""短视频帧率转换检查器。

模块划分:
- ffmpeg_utils: ffmpeg / ffprobe 子进程封装
- probe:         输入校验、时间戳探测、帧解码
- mapping:       帧率转换的帧选取规则(纯 Python, 可独立单测)
- exporter:      CFR mp4 编码与帧对应清单导出
- samples:       内置 CFR / VFR 样例生成
- verify:        基于实际解码输出的核对
- workers / ui:  PySide6 后台任务与主窗口
"""

__version__ = "1.0.0"

TARGET_FPS_CHOICES = (24, 25, 30, 60)
MAX_DURATION_SECONDS = 10.0
MAX_HEIGHT = 720
