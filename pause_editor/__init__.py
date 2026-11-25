"""本地停顿整理工具 (pyside6 + numpy).

模块划分:
- wavfile:      标准库 wave + numpy 的 WAV 读写, 内部统一 float64 [-1,1]
- model:        区间/冲突/拼接计划/拼接引擎/原声<->成品位置映射 (纯 numpy, 无 Qt)
- annotations:  标注 JSON 读写与重映射
- player:       QAudioSink 拉模式试听
- waveform:     波形/区间绘制组件
- main_window:  主窗口
"""

__version__ = "1.0.0"
