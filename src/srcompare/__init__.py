# -*- coding: utf-8 -*-
"""音频采样率对比工具。

模块划分:
- audioio    : WAV 读写、Track 数据结构
- testtone   : 程序生成测试音(低频 / 高频混合 / 左右不同)
- resample   : 基础线性插值 与 soxr 高质量抗混叠重采样
- spectrum   : Welch 频谱、真实赫兹坐标
- measure    : 通带幅度变化、混叠能量、串音与回读校验
- plotting   : matplotlib 波形 / 频谱三路对比图
- playback   : 按各路自身采样率播放(QAudioSink)
- gui        : PySide6 主窗口
"""

ALLOWED_INPUT_RATES = (44100, 48000)
TARGET_RATES = (16000, 44100, 48000)
MAX_DURATION_SEC = 10.0
EDGE_DISCARD_SEC = 0.1          # 测量时每侧舍弃 100ms 滤波/加窗瞬态
TONE_BANDWIDTH_HZ = 5.0         # 单音能量积分半带宽
